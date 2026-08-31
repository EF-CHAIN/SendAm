const stellarAdapter = require('./stellar.adapter');
const { encrypt, decrypt } = require('../services/crypto.service');
const { withIdAlias, withIdAliases } = require('../common/records');
const logger = require('../utils/logger');
const { canonicalizePhoneNumber } = require('../utils/validators');
const { CATALOG } = require('../errors/catalog');
const config = require('../config/env');

const getPrisma = () => require('../common/prisma');
const getWriteAuditLog = () => require('../common/audit.service').writeAuditLog;

const CHAIN = 'stellar';

class WalletNetworkMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WalletNetworkMismatchError';
    this.code = 'WALLET_NETWORK_MISMATCH';
  }
}

// The network this process is bound to. Wallet material is network-specific:
// a testnet secret key is worthless on mainnet and, worse, a mainnet key used
// against testnet Horizon leaks real key material into a test environment.
// Every read and write below is scoped to this value (#283).
const activeNetwork = () => config.stellar.network;

/**
 * Wallets carried over from before network became part of wallet identity
 * inherited the column default rather than being told which network they
 * belong to. They are usable on testnet, where the blast radius is nil, but
 * are refused for mainnet operations until an operator verifies them.
 */
const assertUsableOnActiveNetwork = (wallet) => {
  if (!wallet) return wallet;

  if (wallet.network !== activeNetwork()) {
    throw new WalletNetworkMismatchError(
      `Wallet ${wallet.id} belongs to network '${wallet.network}' but this service is running on `
      + `'${activeNetwork()}'. Wallet material is never shared across networks.`,
    );
  }

  if (config.stellar.isMainnet && wallet.networkProvenance !== 'verified') {
    throw new WalletNetworkMismatchError(
      `Wallet ${wallet.id} has unverified network provenance ('${wallet.networkProvenance}') and `
      + 'cannot be used for a mainnet operation. Verify and re-tag it before use.',
    );
  }

  return wallet;
};


// The issued asset every new wallet should be able to receive from day one.
const USDC = 'USDC';
const PROVISIONING_LEASE_MS = 5 * 60 * 1000;
const MAX_PROVISIONING_ATTEMPTS = 5;
const MAX_TRUSTLINE_ATTEMPTS = 5;
const errorMessage = (error) => String(error?.message || error || 'Unknown provider failure').slice(0, 500);

const RECOVERABLE_ERROR_CODES = Object.freeze({
  account_not_funded: { retryable: true, action: 'fund_account', userMessage: 'Account is not funded yet.' },
  insufficient_reserve: { retryable: false, action: 'add_xlm', userMessage: 'Insufficient XLM reserve.' },
  missing_trustline: { retryable: false, action: 'open_trustline', userMessage: 'Missing trustline for the requested asset.' },
  unsupported_asset: { retryable: false, action: 'none', userMessage: 'Unsupported asset.' },
  bad_sequence: { retryable: true, action: 'retry', userMessage: 'Sequence conflict — will retry.' },
  line_full: { retryable: false, action: 'remove_trustline', userMessage: 'Trustline limit reached.' },
  source_no_trust: { retryable: false, action: 'open_trustline', userMessage: 'Sender has no trustline for this asset.' },
  source_not_authorized: { retryable: false, action: 'contact_support', userMessage: 'Sender trustline is not authorized.' },
});

const classifyRecoverableError = (error) => {
  const code = String(error?.code || 'unknown');
  if (RECOVERABLE_ERROR_CODES[code]) {
    return { ...RECOVERABLE_ERROR_CODES[code], code };
  }
  const classification = stellarAdapter.classifyRecoverableError(error);
  return { ...classification, retryable: Boolean(classification.retryable) };
};

const isProvisioningRetryable = (wallet) => {
  if (wallet.fundingState === 'succeeded' || wallet.funded) return false;
  const classification = classifyRecoverableError(new Error(wallet.fundingError || ''));
  return classification.retryable && wallet.fundingAttempts < MAX_PROVISIONING_ATTEMPTS;
};

const isTrustlineRetryable = (wallet) => {
  if (wallet.trustlineState === 'succeeded') return false;
  const classification = classifyRecoverableError(new Error(wallet.trustlineError || ''));
  return classification.retryable && wallet.trustlineAttempts < MAX_TRUSTLINE_ATTEMPTS;
};

// Open the USDC trustline so a funded wallet can receive USDC immediately.
// Non-fatal, exactly like funding: a failure is logged and the caller carries
// on. establishTrustline is idempotent (no-op when the trustline already
// exists), so this is safe to call on every funding attempt — including the
// fundWallet retry path, which lets a wallet that missed it recover.
const ensureUsdcTrustline = async ({ wallet }) => {
  if (wallet.fundingState !== 'succeeded' && !wallet.funded) return wallet;
  const now = new Date();
  const claimed = await prisma.wallet.updateMany({
    where: { id: wallet.id, OR: [
      { trustlineState: { in: ['pending', 'blocked', 'failed'] } },
      { trustlineState: 'in_progress', trustlineUpdatedAt: { lt: new Date(now.getTime() - PROVISIONING_LEASE_MS) } },
    ] },
    data: { trustlineState: 'in_progress', trustlineAttempts: { increment: 1 }, trustlineError: null, trustlineUpdatedAt: now },
  });
  if (claimed.count === 0) return prisma.wallet.findUnique({ where: { id: wallet.id } });
  try {
    const result = await stellarAdapter.establishTrustline({ secretKey: decrypt(wallet.encryptedSecretKey), assetCode: USDC });
    const updateData = { trustlineState: 'succeeded', trustlineError: null, trustlineUpdatedAt: new Date() };
    if (result.alreadyExisted) updateData.trustlineState = 'succeeded';
    return prisma.wallet.update({ where: { id: wallet.id }, data: updateData });
  } catch (error) {
    const classification = stellarAdapter.classifyTrustlineError(error);
    logger.warn(`USDC trustline ${classification.code} for ${CHAIN} wallet ${wallet.publicKey}: ${error.message}`);
    const isRetryable = classification.retryable && wallet.trustlineAttempts < MAX_TRUSTLINE_ATTEMPTS;
    await prisma.wallet.update({
      where: { id: wallet.id },
      data: {
        trustlineState: isRetryable ? 'pending' : 'failed',
        trustlineError: classification.userMessage.slice(0, 500),
        trustlineUpdatedAt: new Date(),
      },
    });
    await writeAuditLog({
      actorType: 'system',
      action: 'wallet.trustline.failed',
      entityType: 'Wallet',
      entityId: String(wallet.id),
      metadata: { code: classification.code, retryable: isRetryable, action: classification.action, error: errorMessage(error) },
    });
    return prisma.wallet.findUnique({ where: { id: wallet.id } });
  }
};

const provisionWallet = async (walletId) => {
  let wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) throw Object.assign(new Error('Wallet not found'), { statusCode: 404 });
  if (wallet.fundingState !== 'succeeded' && !wallet.funded) {
    const now = new Date();
    const claimed = await prisma.wallet.updateMany({
      where: { id: wallet.id, OR: [
        { fundingState: { in: ['pending', 'failed'] } },
        { fundingState: 'in_progress', fundingUpdatedAt: { lt: new Date(now.getTime() - PROVISIONING_LEASE_MS) } },
      ] },
      data: { fundingState: 'in_progress', fundingAttempts: { increment: 1 }, fundingError: null, fundingUpdatedAt: now },
    });
    if (claimed.count === 0) return prisma.wallet.findUnique({ where: { id: wallet.id } });
    try {
      const result = await stellarAdapter.fundTestnetAccount(wallet.publicKey);
      if (!result.funded) throw new Error('Funding provider did not confirm funding');
      wallet = await prisma.wallet.update({ where: { id: wallet.id }, data: { funded: true, fundingState: 'succeeded', fundingError: null, fundingUpdatedAt: new Date(), trustlineState: 'pending' } });
    } catch (error) {
      const classification = classifyRecoverableError(error);
      logger.warn(`Funding ${classification.code} for ${CHAIN} wallet ${wallet.publicKey}: ${error.message}`);
      const isRetryable = classification.retryable && wallet.fundingAttempts < MAX_PROVISIONING_ATTEMPTS;
      await prisma.wallet.update({
        where: { id: wallet.id },
        data: {
          fundingState: isRetryable ? 'pending' : 'failed',
          fundingError: classification.userMessage.slice(0, 500),
          fundingUpdatedAt: new Date(),
        },
      });
      await writeAuditLog({
        actorType: 'system',
        action: 'wallet.funding.failed',
        entityType: 'Wallet',
        entityId: String(wallet.id),
        metadata: { code: classification.code, retryable: isRetryable, action: classification.action, error: errorMessage(error) },
      });
      return prisma.wallet.findUnique({ where: { id: wallet.id } });
    }
  }
  return ensureUsdcTrustline({ wallet });
};

// Support/admin remediation: safely retry provisioning or trustline for a wallet
// that is in a failed state. Idempotent — calling it on a healthy wallet is a no-op.
const recoverWallet = async ({ walletId, adminId }) => {
  const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) throw Object.assign(new Error('Wallet not found'), { statusCode: 404 });

  if (wallet.fundingState !== 'succeeded' && !wallet.funded) {
    await prisma.wallet.update({
      where: { id: wallet.id },
      data: { fundingState: 'pending', fundingAttempts: 0, fundingError: null, fundingUpdatedAt: new Date() },
    });
    await writeAuditLog({
      actorType: 'administrator',
      actorId: adminId || 'system',
      action: 'wallet.funding.recovered',
      entityType: 'Wallet',
      entityId: String(wallet.id),
      metadata: { chain: CHAIN },
    });
  }

  if (wallet.trustlineState !== 'succeeded') {
    await prisma.wallet.update({
      where: { id: wallet.id },
      data: { trustlineState: 'pending', trustlineAttempts: 0, trustlineError: null, trustlineUpdatedAt: new Date() },
    });
    await writeAuditLog({
      actorType: 'administrator',
      actorId: adminId || 'system',
      action: 'wallet.trustline.recovered',
      entityType: 'Wallet',
      entityId: String(wallet.id),
      metadata: { chain: CHAIN },
    });
  }

  return provisionWallet(wallet.id);
};

// One wallet per user, direct custody: the adapter generates a keypair, the
// secret key is encrypted (crypto.service.js) before it ever touches the
// database. Callers never see a plaintext secret key.
const createOrGetWallet = async ({ user, phoneNumber }) => {
  const prisma = getPrisma();
  const writeAuditLog = getWriteAuditLog();

  let owner = user;
  if (!owner) {
    const canonicalPhone = canonicalizePhoneNumber(phoneNumber);
    owner = await prisma.user.upsert({
      where: { phoneNumber: canonicalPhone },
      create: { phoneNumber: canonicalPhone },
      update: {},
    });
  }
  assertAccountActive(owner);

  const network = activeNetwork();

  const existing = await prisma.wallet.findUnique({
    where: { userId_chain_network: { userId: owner.id, chain: CHAIN, network } },
  });
  if (existing) return withIdAlias(await provisionWallet(existing.id));

  const { publicKey, secretKey } = stellarAdapter.createWallet();

  let wallet;
  try {
    wallet = await prisma.wallet.create({
      // network is written explicitly rather than left to the column default,
      // so the row records the network it was actually created against.
      data: {
        userId: owner.id,
        chain: CHAIN,
        network,
        networkProvenance: 'verified',
        phoneNumber: owner.phoneNumber,
        publicKey,
        encryptedSecretKey: encrypt(secretKey),
      },
    });
  } catch (error) {
    if (error.code !== 'P2002') throw error;
    const winner = await prisma.wallet.findUnique({
      where: { userId_chain_network: { userId: owner.id, chain: CHAIN, network } },
    });
    if (!winner) throw error;
    logger.info(`Recovered concurrent ${CHAIN} wallet creation for user ${owner.id}`);
    await writeAuditLog({ actorType: 'system', actorId: String(owner.id), action: 'wallet.creation.race_recovered', entityType: 'Wallet', entityId: String(winner.id), metadata: { chain: CHAIN, network } });
    return withIdAlias(winner);
  }

  // Attempt funding immediately (Stellar Friendbot on testnet). A failure is
  // non-fatal — callers can retry via fundWallet() later, same as the `fund`
  // WhatsApp command did before.
  wallet = await provisionWallet(wallet.id);

  await writeAuditLog({
    actorType: 'system',
    actorId: String(owner.id),
    action: 'wallet.created',
    entityType: 'Wallet',
    entityId: String(wallet.id),
    metadata: { chain: CHAIN, network },
  });

  // Durable workflow event (#318)
  await appendEvent({
    eventType: EVENT_TYPES.WALLET_CREATED,
    aggregateType: 'Wallet',
    aggregateId: String(wallet.id),
    actorType: 'system',
    actorId: String(owner.id),
    payload: { chain: CHAIN, publicKey: wallet.publicKey, network: wallet.network },
  }).catch(() => {});

  return withIdAlias(wallet);
};

// Creates (or fetches) the user's Stellar wallet. Kept as a list-returning
// helper because callers render wallet lists.
const ensureWalletsForUser = async ({ user }) => {
  const wallet = await createOrGetWallet({ user });
  return [wallet];
};

const getWalletsByPhoneNumber = async (phoneNumber) => {
  const canonicalPhone = canonicalizePhoneNumber(phoneNumber);
  const wallets = await prisma.wallet.findMany({
    where: { phoneNumber: canonicalPhone, chain: CHAIN, network: activeNetwork() },
  });
  return withIdAliases(wallets);
};

const getWalletByUserAndChain = async ({ userId, chain = CHAIN, network = null }) => {
  const wallet = await prisma.wallet.findUnique({
    where: { userId_chain_network: { userId, chain, network: network || activeNetwork() } },
  });
  return withIdAlias(wallet);
};

const fundWallet = async ({ wallet }) => {
  const prisma = getPrisma();
  const result = await stellarAdapter.fundTestnetAccount(wallet.publicKey);
  if (result.funded) {
    // Retry the (idempotent) trustline so a wallet that missed it at creation
    // — e.g. funding succeeded but the trustline call failed — recovers here.
    await ensureUsdcTrustline({
      secretKey: decrypt(wallet.encryptedSecretKey),
      publicKey: wallet.publicKey,
    });
    return { wallet: withIdAlias(await prisma.wallet.update({ where: { id: wallet.id }, data: { funded: true } })), result };
  }
  return { wallet: withIdAlias(wallet), result };
};

const balance = async ({ wallet }) => {
  const value = await stellarAdapter.getBalance(wallet.publicKey);
  return { chain: wallet.chain, address: wallet.publicKey, value };
};

// Balances for every Stellar wallet a user (or phone number) has. Each wallet
// returns per-asset rows via getBalances() so XLM and USDC (and future assets)
// are surfaced individually. Each fetch is isolated — a Horizon failure for
// one wallet sets error and leaves assets empty rather than blanking the whole
// reply. Legacy non-Stellar rows are excluded by query.
const balancesForUser = async ({ userId, phoneNumber }) => {
  const network = activeNetwork();
  const wallets = userId
    ? await prisma.wallet.findMany({ where: { userId, chain: CHAIN, network } })
    : await prisma.wallet.findMany({
      where: { phoneNumber: canonicalizePhoneNumber(phoneNumber), chain: CHAIN, network },
    });

  return Promise.all(wallets.map(async (wallet) => {
    try {
      const assets = await stellarAdapter.getBalances(wallet.publicKey);
      return { chain: wallet.chain, address: wallet.publicKey, assets };
    } catch (error) {
      return { chain: wallet.chain, address: wallet.publicKey, assets: [], error: error.message };
    }
  }));
};

const submitPayment = async ({ wallet, destination, amount, asset, memo, memoType }) => {
  // Last line of defence before a key is decrypted and used to sign.
  assertUsableOnActiveNetwork(wallet);
  const secretKey = decrypt(wallet.encryptedSecretKey);
  return stellarAdapter.submitPayment({ secretKey, destination, amount, asset, memo, memoType });
};

const transactionHistory = async ({ userId }) => {
  const prisma = getPrisma();
  const history = await prisma.transaction.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return withIdAliases(history);
};

module.exports = {
  WalletNetworkMismatchError,
  assertUsableOnActiveNetwork,
  activeNetwork,
  createOrGetWallet,
  ensureWalletsForUser,
  getWalletsByPhoneNumber,
  getWalletByUserAndChain,
  fundWallet,
  provisionWallet,
  recoverWallet,
  balance,
  balancesForUser,
  submitPayment,
  transactionHistory,
  rotateWalletKey: require('./walletRecovery.service').rotateWalletKey,
  initiateWalletRecovery: require('./walletRecovery.service').initiateWalletRecovery,
  completeWalletRecovery: require('./walletRecovery.service').completeWalletRecovery,
};
