'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { StellarSdk } = require('../config/stellar');
const config = require('../config/env');
const { getRedisConnection } = require('../config/redis');
const logger = require('../utils/logger');

const getDefaultPrisma = () => require('../common/prisma');

const TOKEN_KEY_PREFIX = 'sep10:token:';
const REVOKED_KEY_PREFIX = 'sep10:revoked:';
const CHALLENGE_KEY_PREFIX = 'sep10:challenge:';

// In-memory fallback stores used when Redis is not configured or unavailable
// in local/unit-test environments. Entries carry expiry timestamps and are
// pruned lazily on access.
const memoryTokenStore = new Map();
const memoryRevokedStore = new Map();
const memoryChallengeBindings = new Map();

const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const base64UrlEncode = (input) => {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64url');
};

const base64UrlDecode = (input) => Buffer.from(String(input), 'base64url').toString('utf8');

const DOMAIN_REGEX = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/i;
const MAX_UINT64 = 18446744073709551615n;

const createError = (message, statusCode = 400, code = null) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
};

const normalizeDomain = (domain) => {
  if (domain == null || domain === '') return null;
  const trimmed = String(domain).trim().toLowerCase().replace(/\.$/, '');
  if (!trimmed || trimmed.length > 253 || !DOMAIN_REGEX.test(trimmed)) {
    return null;
  }
  return trimmed;
};

const networkPassphrase = (customConfig = config) => {
  if (customConfig?.stellar?.networkPassphrase) {
    return customConfig.stellar.networkPassphrase;
  }
  return customConfig?.stellar?.network === 'testnet'
    ? StellarSdk.Networks.TESTNET
    : StellarSdk.Networks.PUBLIC;
};

const challengeDigest = (transaction, customConfig = config) => new StellarSdk.Transaction(
  transaction,
  networkPassphrase(customConfig),
).hash().toString('hex');

const authConfig = (customConfig = config) => {
  const settings = customConfig?.stellar?.auth || {};
  if (!settings.signingKey || !settings.homeDomain || !settings.webAuthDomain) {
    throw createError('Stellar authentication is not configured', 503, 'auth_not_configured');
  }
  return {
    signingKey: settings.signingKey,
    homeDomain: String(settings.homeDomain).trim().toLowerCase(),
    allowedHomeDomains: Array.isArray(settings.allowedHomeDomains) && settings.allowedHomeDomains.length
      ? settings.allowedHomeDomains.map((d) => String(d).trim().toLowerCase()).filter(Boolean)
      : [String(settings.homeDomain).trim().toLowerCase()],
    webAuthDomain: String(settings.webAuthDomain).trim().toLowerCase(),
    challengeTtlSeconds: Number(settings.challengeTtlSeconds || 300),
    sessionTtlMinutes: Number(settings.sessionTtlMinutes || 15),
    jwtSecret: settings.jwtSecret || customConfig?.admin?.jwtSecret || settings.signingKey,
    clientDomainKeys: settings.clientDomainKeys || {},
  };
};

const isValidStellarAccount = (account) => {
  if (typeof account !== 'string' || !account) return false;
  return (
    StellarSdk.StrKey.isValidEd25519PublicKey(account)
    || StellarSdk.StrKey.isValidMed25519PublicKey(account)
  );
};

const extractBaseAccount = (account) => {
  if (typeof account !== 'string') return account;
  if (StellarSdk.StrKey.isValidMed25519PublicKey(account)) {
    try {
      const muxed = StellarSdk.MuxedAccount.fromAddress(account, '0');
      return muxed.baseAccount().accountId();
    } catch (_err) {
      return account;
    }
  }
  return account;
};

const validateMemo = (memo, account) => {
  if (memo == null || memo === '') return null;
  if (typeof account === 'string' && account.startsWith('M')) {
    throw createError('Memo cannot be used when account is a muxed account (M...)', 400, 'invalid_memo');
  }
  const memoStr = String(memo).trim();
  if (!/^\d+$/.test(memoStr)) {
    throw createError('Invalid memo: SEP-10 memo must be a 64-bit unsigned integer', 400, 'invalid_memo');
  }
  const parsed = BigInt(memoStr);
  if (parsed < 0n || parsed > MAX_UINT64) {
    throw createError('Invalid memo: value exceeds 64-bit unsigned integer range', 400, 'invalid_memo');
  }
  return memoStr;
};

const resolveHomeDomain = (requestedHomeDomain, settings) => {
  if (requestedHomeDomain == null || requestedHomeDomain === '') {
    return settings.homeDomain;
  }
  const normalized = normalizeDomain(requestedHomeDomain);
  if (!normalized) {
    throw createError('Invalid home_domain format', 400, 'invalid_home_domain');
  }
  if (!settings.allowedHomeDomains.includes(normalized)) {
    throw createError(
      `Unsupported home_domain "${normalized}". Expected ${settings.homeDomain}`,
      400,
      'home_domain_mismatch',
    );
  }
  return normalized;
};

const resolveClientDomainAndKey = async ({
  clientDomain,
  clientSigningKey,
  settings,
  serverPublicKey,
  resolveClientSigningKey,
  axiosImpl = axios,
}) => {
  if (clientDomain == null || clientDomain === '') {
    return { clientDomain: null, clientSigningKey: null, explicitClientSigner: false };
  }
  const normalized = normalizeDomain(clientDomain);
  if (!normalized) {
    throw createError('Invalid client_domain format', 400, 'invalid_client_domain');
  }

  let resolvedKey = clientSigningKey || settings.clientDomainKeys?.[normalized] || null;
  if (!resolvedKey && typeof resolveClientSigningKey === 'function') {
    resolvedKey = await resolveClientSigningKey(normalized, { axiosImpl });
  }

  if (resolvedKey) {
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(resolvedKey)) {
      throw createError('Invalid client_signing_key for client_domain', 400, 'invalid_client_signing_key');
    }
    return {
      clientDomain: normalized,
      clientSigningKey: resolvedKey,
      explicitClientSigner: resolvedKey !== serverPublicKey,
    };
  }

  return {
    clientDomain: normalized,
    clientSigningKey: null,
    explicitClientSigner: false,
  };
};

// ---- Redis / Memory state helpers ------------------------------------------

const getRedisClient = (options = {}) => {
  if (options.redis !== undefined) return options.redis;
  try {
    return getRedisConnection(options.config || config);
  } catch (_err) {
    return null;
  }
};

const setWithTtl = async (redisClient, memoryMap, key, value, ttlSeconds) => {
  const safeTtl = Math.max(1, Math.floor(Number(ttlSeconds) || 60));
  const expiresAtMs = Date.now() + safeTtl * 1000;
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  memoryMap.set(key, { value: serialized, expiresAtMs });

  if (redisClient && typeof redisClient.set === 'function') {
    try {
      await redisClient.set(key, serialized, 'EX', safeTtl);
    } catch (err) {
      logger.warn('sep10_redis_set_failed', { key, message: err.message });
    }
  }
};

const getWithTtl = async (redisClient, memoryMap, key) => {
  if (redisClient && typeof redisClient.get === 'function') {
    try {
      const raw = await redisClient.get(key);
      if (raw != null) return raw;
    } catch (err) {
      logger.warn('sep10_redis_get_failed', { key, message: err.message });
    }
  }

  const entry = memoryMap.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs <= Date.now()) {
    memoryMap.delete(key);
    return null;
  }
  return entry.value;
};

const delKey = async (redisClient, memoryMap, key) => {
  memoryMap.delete(key);
  if (redisClient && typeof redisClient.del === 'function') {
    try {
      await redisClient.del(key);
    } catch (err) {
      logger.warn('sep10_redis_del_failed', { key, message: err.message });
    }
  }
};

// ---- JWT Minting & Verification (RFC 7519 HS256) ---------------------------

const signJwt = (payload, secret) => {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .createHmac('sha256', String(secret))
    .update(signingInput)
    .digest('base64url');
  return `${signingInput}.${signature}`;
};

const verifyJwtSignature = (token, secret) => {
  if (typeof token !== 'string') {
    throw createError('Invalid SEP-10 token', 401, 'invalid_token');
  }
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw createError('Malformed SEP-10 JWT token', 401, 'malformed_token');
  }
  const [encodedHeader, encodedPayload, providedSignature] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(base64UrlDecode(encodedHeader));
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch (_err) {
    throw createError('Malformed SEP-10 JWT payload', 401, 'malformed_token');
  }

  if (!header || header.alg !== 'HS256') {
    throw createError('Unsupported JWT signing algorithm', 401, 'invalid_token_alg');
  }

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = crypto
    .createHmac('sha256', String(secret))
    .update(signingInput)
    .digest('base64url');

  const a = Buffer.from(providedSignature);
  const b = Buffer.from(expectedSignature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw createError('Invalid SEP-10 JWT signature', 401, 'invalid_token_signature');
  }

  return payload;
};

// ---- Public SEP-10 Operations ----------------------------------------------

/**
 * Issues a SEP-10 challenge transaction bound to home_domain, web_auth_domain,
 * network passphrase, and optional client_domain / memo.
 */
const createChallenge = async (input, options = {}) => {
  const params = typeof input === 'string' || input == null
    ? { account: input, ...options }
    : { ...input, ...options };

  const customConfig = params.config || config;
  const prismaClient = params.prisma || getDefaultPrisma();
  const redisClient = getRedisClient(params);

  const account = params.account;
  if (!isValidStellarAccount(account)) {
    throw createError('A valid Stellar account is required', 400, 'invalid_account');
  }

  const settings = authConfig(customConfig);
  const memo = validateMemo(params.memo, account);
  const requestedHomeDomain = params.homeDomain !== undefined ? params.homeDomain : params.home_domain;
  const requestedClientDomain = params.clientDomain !== undefined ? params.clientDomain : params.client_domain;
  const requestedClientSigningKey = params.clientSigningKey !== undefined
    ? params.clientSigningKey
    : params.client_signing_key;

  const resolvedHomeDomain = resolveHomeDomain(requestedHomeDomain, settings);
  const serverKeypair = StellarSdk.Keypair.fromSecret(settings.signingKey);
  const passphrase = networkPassphrase(customConfig);

  const {
    clientDomain: resolvedClientDomain,
    clientSigningKey: resolvedClientSigningKey,
    explicitClientSigner,
  } = await resolveClientDomainAndKey({
    clientDomain: requestedClientDomain,
    clientSigningKey: requestedClientSigningKey,
    settings,
    serverPublicKey: serverKeypair.publicKey(),
    resolveClientSigningKey: params.resolveClientSigningKey,
    axiosImpl: params.axiosImpl,
  });

  const transaction = StellarSdk.WebAuth.buildChallengeTx(
    serverKeypair,
    account,
    resolvedHomeDomain,
    settings.challengeTtlSeconds,
    passphrase,
    settings.webAuthDomain,
    memo,
    resolvedClientSigningKey ? resolvedClientDomain : null,
    resolvedClientSigningKey || null,
  );

  const challengeHash = challengeDigest(transaction, customConfig);
  const expiresAt = new Date(Date.now() + settings.challengeTtlSeconds * 1000);
  const baseAccount = extractBaseAccount(account);

  await prismaClient.sep10Challenge.create({
    data: {
      account: baseAccount,
      challengeHash,
      expiresAt,
    },
  });

  const binding = {
    challengeHash,
    account,
    baseAccount,
    memo,
    homeDomain: resolvedHomeDomain,
    webAuthDomain: settings.webAuthDomain,
    clientDomain: resolvedClientDomain,
    clientSigningKey: explicitClientSigner ? resolvedClientSigningKey : null,
    network: customConfig?.stellar?.network || 'testnet',
    networkPassphrase: passphrase,
    expiresAt: expiresAt.toISOString(),
  };

  await setWithTtl(
    redisClient,
    memoryChallengeBindings,
    `${CHALLENGE_KEY_PREFIX}${challengeHash}`,
    binding,
    settings.challengeTtlSeconds,
  );

  return {
    transaction,
    network_passphrase: passphrase,
    networkPassphrase: passphrase,
    homeDomain: resolvedHomeDomain,
    clientDomain: resolvedClientDomain,
    expiresAt,
  };
};

/**
 * Extracts client_domain manageData operation from a challenge transaction if present.
 */
const extractClientDomainFromTx = (tx) => {
  if (!tx || !Array.isArray(tx.operations)) return null;
  const op = tx.operations.find((operation) => operation.type === 'manageData' && operation.name === 'client_domain');
  if (!op || !op.value) return null;
  return {
    clientDomain: Buffer.from(op.value).toString('utf8').trim().toLowerCase(),
    clientSigningKey: op.source || null,
  };
};

/**
 * Extracts home_domain from the first manageData operation (<home_domain> auth) of a challenge transaction.
 */
const extractHomeDomainFromTx = (tx) => {
  if (!tx || !Array.isArray(tx.operations) || !tx.operations.length) return null;
  const firstOp = tx.operations[0];
  if (firstOp.type !== 'manageData' || typeof firstOp.name !== 'string') return null;
  if (!firstOp.name.endsWith(' auth')) return null;
  return firstOp.name.slice(0, -5).trim().toLowerCase();
};

/**
 * Validates a signed SEP-10 challenge transaction, enforces single-use replay
 * protection, verifies home_domain and client_domain bindings, mints a JWT
 * session token, and stores the token hash in Redis with TTL.
 */
const verifyChallenge = async (input, options = {}) => {
  const params = typeof input === 'string' || input == null
    ? { transaction: input, ...options }
    : { ...input, ...options };

  const signedTransaction = params.transaction;
  if (typeof signedTransaction !== 'string' || !signedTransaction.trim() || signedTransaction.length > 10000) {
    throw createError('Malformed challenge transaction', 400, 'malformed_challenge');
  }

  const customConfig = params.config || config;
  const prismaClient = params.prisma || getDefaultPrisma();
  const redisClient = getRedisClient(params);
  const settings = authConfig(customConfig);
  const passphrase = networkPassphrase(customConfig);
  const serverKeypair = StellarSdk.Keypair.fromSecret(settings.signingKey);

  // Pre-parse transaction if possible to detect explicit domain or network mismatches clearly
  let rawTx;
  try {
    rawTx = new StellarSdk.Transaction(signedTransaction, passphrase);
  } catch (_err) {
    throw createError('Invalid signed challenge', 401, 'invalid_challenge');
  }

  const txHomeDomain = extractHomeDomainFromTx(rawTx);
  const requestedHomeDomain = params.homeDomain !== undefined ? params.homeDomain : params.home_domain;
  if (requestedHomeDomain && normalizeDomain(requestedHomeDomain) !== txHomeDomain) {
    throw createError('Challenge home_domain does not match requested home_domain', 401, 'home_domain_mismatch');
  }
  if (!txHomeDomain || !settings.allowedHomeDomains.includes(txHomeDomain)) {
    throw createError(
      `Invalid signed challenge: wrong home domain "${txHomeDomain || 'unknown'}"`,
      401,
      'home_domain_mismatch',
    );
  }

  let challenge;
  try {
    challenge = StellarSdk.WebAuth.readChallengeTx(
      signedTransaction,
      serverKeypair.publicKey(),
      passphrase,
      settings.allowedHomeDomains,
      settings.webAuthDomain,
    );
  } catch (_error) {
    throw createError('Invalid signed challenge', 401, 'invalid_challenge');
  }

  const challengeHash = challengeDigest(signedTransaction, customConfig);
  const storedBindingRaw = await getWithTtl(
    redisClient,
    memoryChallengeBindings,
    `${CHALLENGE_KEY_PREFIX}${challengeHash}`,
  );
  const storedBinding = storedBindingRaw ? JSON.parse(storedBindingRaw) : null;

  if (storedBinding) {
    if (storedBinding.homeDomain && storedBinding.homeDomain !== challenge.matchedHomeDomain) {
      throw createError('Challenge home_domain binding mismatch', 401, 'home_domain_mismatch');
    }
    if (storedBinding.network && storedBinding.network !== (customConfig?.stellar?.network || 'testnet')) {
      throw createError('Challenge network binding mismatch', 401, 'network_mismatch');
    }
  }

  const txClientDomainInfo = extractClientDomainFromTx(challenge.tx);
  const effectiveClientDomain = txClientDomainInfo?.clientDomain || storedBinding?.clientDomain || null;
  const requestedClientDomain = params.clientDomain !== undefined ? params.clientDomain : params.client_domain;
  if (storedBinding?.clientDomain && txClientDomainInfo) {
    if (txClientDomainInfo.clientDomain !== storedBinding.clientDomain) {
      throw createError('Challenge client_domain binding mismatch', 401, 'client_domain_mismatch');
    }
  }
  if (storedBinding?.clientSigningKey) {
    if (!txClientDomainInfo || txClientDomainInfo.clientSigningKey !== storedBinding.clientSigningKey) {
      throw createError('Challenge client_signing_key binding mismatch', 401, 'client_domain_mismatch');
    }
  }
  if (requestedClientDomain) {
    const normalizedReqClient = normalizeDomain(requestedClientDomain);
    if (!effectiveClientDomain || effectiveClientDomain !== normalizedReqClient) {
      throw createError('Signed challenge does not match expected client_domain', 401, 'client_domain_mismatch');
    }
  }

  const baseClientAccount = extractBaseAccount(challenge.clientAccountID);

  try {
    const verifiedSigners = StellarSdk.WebAuth.verifyChallengeTxSigners(
      signedTransaction,
      serverKeypair.publicKey(),
      passphrase,
      [baseClientAccount],
      settings.allowedHomeDomains,
      settings.webAuthDomain,
    );
    if (!verifiedSigners.includes(baseClientAccount)) {
      throw new Error(`Missing required signature from ${baseClientAccount}`);
    }
  } catch (_error) {
    throw createError('Invalid signed challenge', 401, 'invalid_challenge_signature');
  }

  const wallet = prismaClient.wallet?.findFirst
    ? await prismaClient.wallet.findFirst({
      where: { publicKey: baseClientAccount, network: customConfig.stellar.network },
      include: { user: true },
    })
    : null;

  if (!wallet && params.requireLinkedWallet === true) {
    throw createError('Stellar account is not linked to a user on this network', 401, 'wallet_not_linked');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttlSeconds = Math.max(60, Math.floor(settings.sessionTtlMinutes * 60));
  const expSeconds = nowSeconds + ttlSeconds;
  const expiresAt = new Date(expSeconds * 1000);
  const jti = crypto.randomUUID();
  const sub = challenge.memo
    ? `${challenge.clientAccountID}:${challenge.memo}`
    : challenge.clientAccountID;

  const jwtClaims = {
    iss: `https://${settings.webAuthDomain}/auth`,
    sub,
    account: baseClientAccount,
    iat: nowSeconds,
    exp: expSeconds,
    jti,
    home_domain: challenge.matchedHomeDomain,
    ...(effectiveClientDomain ? { client_domain: effectiveClientDomain } : {}),
    ...(challenge.memo ? { memo: challenge.memo } : {}),
    network: customConfig.stellar.network,
  };

  const token = signJwt(jwtClaims, settings.jwtSecret);
  const tokenHash = hash(token);

  await prismaClient.$transaction(async (tx) => {
    const consumed = await tx.sep10Challenge.updateMany({
      where: {
        challengeHash,
        account: baseClientAccount,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) {
      throw createError('Challenge is expired, unknown, or already used', 401, 'challenge_replay_or_expired');
    }
    if (wallet?.userId && tx.restSession?.create) {
      await tx.restSession.create({
        data: {
          userId: wallet.userId,
          account: baseClientAccount,
          tokenHash,
          expiresAt,
        },
      });
    }
  });

  await delKey(redisClient, memoryChallengeBindings, `${CHALLENGE_KEY_PREFIX}${challengeHash}`);

  const tokenRecord = {
    jti,
    tokenHash,
    sub,
    account: baseClientAccount,
    userId: wallet?.userId || null,
    homeDomain: challenge.matchedHomeDomain,
    clientDomain: effectiveClientDomain,
    network: customConfig.stellar.network,
    issuedAt: new Date(nowSeconds * 1000).toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  await setWithTtl(
    redisClient,
    memoryTokenStore,
    `${TOKEN_KEY_PREFIX}${tokenHash}`,
    tokenRecord,
    ttlSeconds,
  );

  return {
    token,
    tokenHash,
    expiresAt,
    user: wallet?.user || null,
    account: baseClientAccount,
    sub,
    homeDomain: challenge.matchedHomeDomain,
    clientDomain: effectiveClientDomain,
    claims: jwtClaims,
  };
};

/**
 * Verifies a SEP-10 JWT token against signature, expiration, home_domain,
 * network binding, and Redis revocation / active TTL state.
 */
const verifyToken = async (token, options = {}) => {
  if (typeof token !== 'string' || !token.trim()) {
    throw createError('Authentication token is required', 401, 'missing_token');
  }

  const customConfig = options.config || config;
  const prismaClient = options.prisma || getDefaultPrisma();
  const redisClient = getRedisClient(options);
  const settings = authConfig(customConfig);

  const claims = verifyJwtSignature(token, settings.jwtSecret);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!claims.exp || Number(claims.exp) <= nowSeconds) {
    throw createError('SEP-10 token has expired', 401, 'token_expired');
  }

  const expectedHomeDomain = options.homeDomain
    ? normalizeDomain(options.homeDomain)
    : null;
  if (expectedHomeDomain && claims.home_domain !== expectedHomeDomain) {
    throw createError('Token home_domain does not match expected domain', 401, 'home_domain_mismatch');
  }
  if (!claims.home_domain || !settings.allowedHomeDomains.includes(String(claims.home_domain).toLowerCase())) {
    throw createError('Token was issued for an unauthorized home_domain', 401, 'home_domain_mismatch');
  }

  if (claims.network && claims.network !== customConfig.stellar.network) {
    throw createError('Token network does not match active Stellar network', 401, 'network_mismatch');
  }

  const tokenHash = hash(token);

  // Check explicit revocation tombstone first
  const revokedRaw = await getWithTtl(
    redisClient,
    memoryRevokedStore,
    `${REVOKED_KEY_PREFIX}${tokenHash}`,
  );
  if (revokedRaw) {
    throw createError('SEP-10 token has been revoked', 401, 'token_revoked');
  }

  // If Redis or memory store tracks active tokens, ensure it has not been evicted/invalidated
  const storedTokenRaw = await getWithTtl(
    redisClient,
    memoryTokenStore,
    `${TOKEN_KEY_PREFIX}${tokenHash}`,
  );
  if (options.requireActiveStore !== false && !storedTokenRaw) {
    // Also check prisma restSession if available before failing
    const dbSession = prismaClient?.restSession?.findUnique
      ? await prismaClient.restSession.findUnique({ where: { tokenHash } })
      : null;
    if (!dbSession || dbSession.revokedAt || dbSession.expiresAt <= new Date()) {
      throw createError('SEP-10 token is expired, unknown, or revoked', 401, 'token_invalid');
    }
  }

  const storedToken = storedTokenRaw ? JSON.parse(storedTokenRaw) : null;
  return {
    valid: true,
    tokenHash,
    claims,
    account: claims.account || extractBaseAccount(claims.sub),
    sub: claims.sub,
    homeDomain: claims.home_domain,
    clientDomain: claims.client_domain || null,
    userId: storedToken?.userId || null,
    expiresAt: new Date(Number(claims.exp) * 1000),
  };
};

/**
 * Revokes an active SEP-10 token immediately by deleting its active Redis key,
 * writing a revocation tombstone for the remaining TTL, and revoking any linked
 * RestSession record.
 */
const revokeToken = async (token, options = {}) => {
  if (typeof token !== 'string' || !token.trim()) {
    throw createError('Token is required for revocation', 400, 'missing_token');
  }

  const customConfig = options.config || config;
  const prismaClient = options.prisma || getDefaultPrisma();
  const redisClient = getRedisClient(paramsFromOptions(options));
  const settings = authConfig(customConfig);

  const tokenHash = hash(token);
  let remainingTtlSeconds = Math.max(60, Math.floor(settings.sessionTtlMinutes * 60));

  try {
    const claims = verifyJwtSignature(token, settings.jwtSecret);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (claims.exp && Number(claims.exp) > nowSeconds) {
      remainingTtlSeconds = Number(claims.exp) - nowSeconds;
    }
  } catch (_err) {
    // Even if token is not a JWT (e.g. opaque token), still revoke its hash
  }

  await delKey(redisClient, memoryTokenStore, `${TOKEN_KEY_PREFIX}${tokenHash}`);
  await setWithTtl(
    redisClient,
    memoryRevokedStore,
    `${REVOKED_KEY_PREFIX}${tokenHash}`,
    { tokenHash, revokedAt: new Date().toISOString() },
    remainingTtlSeconds,
  );

  if (prismaClient?.restSession?.updateMany) {
    try {
      await prismaClient.restSession.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } catch (_err) {
      // ignore if DB session table is not used for external wallet token
    }
  }

  return {
    revoked: true,
    tokenHash,
    revokedAt: new Date(),
  };
};

const paramsFromOptions = (options = {}) => ({
  config: options.config || config,
  prisma: options.prisma,
  redis: options.redis,
});

/**
 * Refreshes an active, non-revoked SEP-10 token by revoking the current token
 * and issuing a new JWT with a fresh TTL while preserving domain and account bindings.
 */
const refreshToken = async (token, options = {}) => {
  const verified = await verifyToken(token, options);
  const customConfig = options.config || config;
  const prismaClient = options.prisma || getDefaultPrisma();
  const redisClient = getRedisClient(options);
  const settings = authConfig(customConfig);

  await revokeToken(token, options);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttlSeconds = Math.max(60, Math.floor(settings.sessionTtlMinutes * 60));
  const expSeconds = nowSeconds + ttlSeconds;
  const expiresAt = new Date(expSeconds * 1000);
  const jti = crypto.randomUUID();

  const nextClaims = {
    iss: verified.claims.iss || `https://${settings.webAuthDomain}/auth`,
    sub: verified.sub,
    account: verified.account,
    iat: nowSeconds,
    exp: expSeconds,
    jti,
    home_domain: verified.homeDomain,
    ...(verified.clientDomain ? { client_domain: verified.clientDomain } : {}),
    ...(verified.claims.memo ? { memo: verified.claims.memo } : {}),
    network: customConfig.stellar.network,
  };

  const newToken = signJwt(nextClaims, settings.jwtSecret);
  const newTokenHash = hash(newToken);

  const tokenRecord = {
    jti,
    tokenHash: newTokenHash,
    sub: verified.sub,
    account: verified.account,
    userId: verified.userId,
    homeDomain: verified.homeDomain,
    clientDomain: verified.clientDomain,
    network: customConfig.stellar.network,
    issuedAt: new Date(nowSeconds * 1000).toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  await setWithTtl(
    redisClient,
    memoryTokenStore,
    `${TOKEN_KEY_PREFIX}${newTokenHash}`,
    tokenRecord,
    ttlSeconds,
  );

  if (verified.userId && prismaClient?.restSession?.create) {
    try {
      await prismaClient.restSession.create({
        data: {
          userId: verified.userId,
          account: verified.account,
          tokenHash: newTokenHash,
          expiresAt,
        },
      });
    } catch (_err) {
      // ignore if user session persistence is mocked or unavailable
    }
  }

  return {
    token: newToken,
    tokenHash: newTokenHash,
    expiresAt,
    account: verified.account,
    sub: verified.sub,
    homeDomain: verified.homeDomain,
    clientDomain: verified.clientDomain,
    claims: nextClaims,
  };
};

const clearMemoryStores = () => {
  memoryTokenStore.clear();
  memoryRevokedStore.clear();
  memoryChallengeBindings.clear();
};

module.exports = {
  createChallenge,
  verifyChallenge,
  verifyToken,
  revokeToken,
  refreshToken,
  signJwt,
  verifyJwtSignature,
  normalizeDomain,
  isValidStellarAccount,
  extractBaseAccount,
  validateMemo,
  hash,
  clearMemoryStores,
  TOKEN_KEY_PREFIX,
  REVOKED_KEY_PREFIX,
  CHALLENGE_KEY_PREFIX,
};
