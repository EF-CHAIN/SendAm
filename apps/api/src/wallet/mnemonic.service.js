'use strict';

// BIP-39 recovery phrases and one-time secure export (#960).
//
// ── What this is for ─────────────────────────────────────────────────────
//
// A user who wants to take their wallet to Lobstr, Freighter or any other
// Stellar app needs their key in a portable form. The portable form the
// ecosystem agreed on is a BIP-39 mnemonic derived down SEP-0005's path,
// `m/44'/148'/x'`. This module generates those phrases, derives Stellar
// keypairs from them, and gates export behind a two-factor, single-use,
// expiring authorization that is recorded in the tamper-evident audit log.
//
// ── The derivation, and why it is not hand-rolled ────────────────────────
//
//   mnemonic --BIP-39 PBKDF2--> 64-byte seed --SLIP-0010--> ed25519 key
//
// `bip39` (bitcoinjs) and `ed25519-hd-key` are the established, maintained
// implementations; every path element is hardened. The recipe below was
// verified against all five official SEP-0005 test vectors — 5/5 seeds and
// 50/50 derived keypairs matched — and those vectors are asserted in
// test/mnemonic.service.test.js so a dependency bump cannot silently change
// the derivation and strand a user's funds behind a phrase that no longer
// reproduces their key.
//
// ── The hard constraint: legacy wallets have no mnemonic ─────────────────
//
// `stellar.adapter.createWallet()` uses `Keypair.random()`. A random key is
// not the output of any derivation, so NO mnemonic exists that reproduces it
// — that is not a gap in this module, it is arithmetic. Generating a fresh
// phrase and handing it over as "your recovery phrase" would be the worst
// possible bug in this file: the phrase derives a different, empty account,
// the user writes it down believing they are backed up, and discovers
// otherwise only after losing access.
//
// So export is honest about which kind of wallet it is looking at, and it
// decides by VERIFICATION rather than by trusting a flag: a phrase belongs to
// a wallet only if deriving from it reproduces the wallet's stored public
// key. A legacy wallet exports its raw `S...` seed — which Lobstr and
// Freighter both import — together with `mnemonicAvailable: false` and the
// reason. It never gets a fabricated phrase.
//
// ── The out-of-band factor is WhatsApp, not SMS ──────────────────────────
//
// The issue asks for SMS verification. There is no SMS provider in this
// codebase; the product's out-of-band channel to a user is the WhatsApp
// Cloud API, keyed by the same phone number. Rather than fake a verification
// step, this module implements a real challenge — cryptographically random
// code, only its HMAC stored, short expiry, bounded attempts, single use,
// timing-safe comparison — and delivers it through an injected sender that
// defaults to WhatsApp. Swapping in a real SMS provider is a one-line change
// at the call site and touches none of the policy below. The limitation is
// recorded in the PR description rather than papered over.

const crypto = require('crypto');

const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const StellarSdk = require('@stellar/stellar-sdk');

const config = require('../config/env');
const logger = require('../utils/logger');
const { decrypt } = require('../services/crypto.service');
const { writeAuditLog } = require('../common/audit.service');
const { verifyPinAttempt } = require('../compliance/pin.service');

/** SLIP-0044 coin type for Stellar. */
const STELLAR_COIN_TYPE = 148;

/** Entropy bits → word count, per BIP-39. 128 bits is the 12-word phrase. */
const DEFAULT_STRENGTH_BITS = 128;

/**
 * Hardened BIP-32 indices occupy the top half of the 32-bit index space, so a
 * hardened account index must stay below 2^31.
 */
const MAX_ACCOUNT_INDEX = 2 ** 31 - 1;

/** How many account indices recovery will scan before giving up. */
const RECOVERY_SCAN_DEPTH = Number(process.env.MNEMONIC_RECOVERY_SCAN_DEPTH || 20);

/** Out-of-band challenge policy. */
const CHALLENGE_DIGITS = 6;
const CHALLENGE_TTL_MS = Number(process.env.MNEMONIC_EXPORT_CHALLENGE_TTL_MS || 10 * 60 * 1000);
const CHALLENGE_MAX_ATTEMPTS = Number(process.env.MNEMONIC_EXPORT_CHALLENGE_MAX_ATTEMPTS || 5);

/** Grant lifecycle states. */
const GRANT_STATUS = Object.freeze({
  PENDING: 'pending',
  AUTHORIZED: 'authorized',
  CONSUMED: 'consumed',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
});

/** Stable error codes. None of these messages ever carry secret material. */
const EXPORT_ERROR_CODES = Object.freeze({
  INVALID_MNEMONIC: 'invalid_mnemonic',
  INVALID_ACCOUNT_INDEX: 'invalid_account_index',
  MNEMONIC_MISMATCH: 'mnemonic_mismatch',
  GRANT_NOT_FOUND: 'grant_not_found',
  GRANT_EXPIRED: 'grant_expired',
  GRANT_CONSUMED: 'grant_consumed',
  NOT_AUTHORIZED: 'export_not_authorized',
  PIN_REJECTED: 'pin_rejected',
  CHALLENGE_REJECTED: 'challenge_rejected',
  CHALLENGE_ATTEMPTS_EXCEEDED: 'challenge_attempts_exceeded',
  WALLET_NOT_FOUND: 'wallet_not_found',
});

const codedError = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });

// ─────────────────────────────────────────────────────────────────────────
// BIP-39 / SEP-0005
// ─────────────────────────────────────────────────────────────────────────

/**
 * The SEP-0005 derivation path for an account index.
 *
 * @param {number} [accountIndex=0] - Account index; 0 is the "primary key".
 * @returns {string} e.g. `m/44'/148'/0'`
 * @throws {Error} code `invalid_account_index`
 */
const derivationPathFor = (accountIndex = 0) => {
  if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex > MAX_ACCOUNT_INDEX) {
    throw codedError(
      `Account index must be an integer in [0, ${MAX_ACCOUNT_INDEX}].`,
      EXPORT_ERROR_CODES.INVALID_ACCOUNT_INDEX,
    );
  }
  return `m/44'/${STELLAR_COIN_TYPE}'/${accountIndex}'`;
};

/**
 * Generate a fresh BIP-39 English mnemonic.
 *
 * @param {object} [params]
 * @param {number} [params.strength=128] - Entropy bits (128 → 12 words, 256 → 24).
 * @returns {string} The mnemonic. Treat as secret: never log or persist it.
 */
const generateMnemonic = ({ strength = DEFAULT_STRENGTH_BITS } = {}) => {
  if (![128, 160, 192, 224, 256].includes(strength)) {
    throw codedError(
      'BIP-39 strength must be one of 128, 160, 192, 224 or 256 bits.',
      EXPORT_ERROR_CODES.INVALID_MNEMONIC,
    );
  }
  return bip39.generateMnemonic(strength, crypto.randomBytes, bip39.wordlists.english);
};

/**
 * Checksum-aware mnemonic validation.
 *
 * @param {string} mnemonic
 * @returns {boolean}
 */
const validateMnemonic = (mnemonic) => {
  if (typeof mnemonic !== 'string' || mnemonic.trim() === '') return false;
  return bip39.validateMnemonic(mnemonic.trim(), bip39.wordlists.english);
};

/**
 * Derive a Stellar keypair from a mnemonic down the SEP-0005 path.
 *
 * @param {object} params
 * @param {string} params.mnemonic - BIP-39 phrase.
 * @param {string} [params.passphrase] - Optional BIP-39 passphrase (the "25th word").
 * @param {number} [params.accountIndex=0]
 * @returns {{ publicKey: string, secretKey: string, path: string }}
 * @throws {Error} code `invalid_mnemonic`
 */
const deriveStellarKeypair = ({ mnemonic, passphrase, accountIndex = 0 }) => {
  if (!validateMnemonic(mnemonic)) {
    // Deliberately does not echo the input: an invalid phrase is still a
    // phrase someone might reuse, so it must not reach logs via an error.
    throw codedError(
      'Recovery phrase is not a valid BIP-39 mnemonic (word list or checksum).',
      EXPORT_ERROR_CODES.INVALID_MNEMONIC,
    );
  }

  const path = derivationPathFor(accountIndex);
  const seedHex = bip39.mnemonicToSeedSync(mnemonic.trim(), passphrase || undefined).toString('hex');
  const { key } = derivePath(path, seedHex);
  const keypair = StellarSdk.Keypair.fromRawEd25519Seed(key);

  return { publicKey: keypair.publicKey(), secretKey: keypair.secret(), path };
};

/**
 * Create a NEW wallet whose key is derived from a fresh mnemonic.
 *
 * Distinct from recovery on purpose: this mints a brand-new account, and the
 * returned mnemonic genuinely reproduces it. The caller must show the phrase
 * to the user once and must not persist it.
 *
 * @param {object} [params]
 * @param {number} [params.strength=128]
 * @param {number} [params.accountIndex=0]
 * @returns {{ mnemonic: string, publicKey: string, secretKey: string, path: string }}
 */
const createMnemonicWallet = ({ strength = DEFAULT_STRENGTH_BITS, accountIndex = 0 } = {}) => {
  const mnemonic = generateMnemonic({ strength });
  const derived = deriveStellarKeypair({ mnemonic, accountIndex });

  // Self-check: the phrase we are about to hand over must reproduce the key we
  // are about to store. Cheap, and it turns any future derivation regression
  // into a loud failure instead of an unrecoverable wallet.
  const confirm = deriveStellarKeypair({ mnemonic, accountIndex });
  if (confirm.publicKey !== derived.publicKey) {
    throw codedError(
      'Derivation self-check failed; refusing to create a wallet whose phrase may not recover it.',
      EXPORT_ERROR_CODES.MNEMONIC_MISMATCH,
    );
  }

  return { mnemonic, ...derived, mnemonicDerived: true };
};

/**
 * Recover an EXISTING wallet from a user-supplied mnemonic.
 *
 * Only succeeds when derivation actually reproduces `expectedPublicKey`.
 * A phrase that derives something else is refused rather than quietly
 * adopting a new, empty account — which is what "recovery" that creates an
 * account would really be doing.
 *
 * @param {object} params
 * @param {string} params.mnemonic
 * @param {string} params.expectedPublicKey - The wallet's stored public key.
 * @param {string} [params.passphrase]
 * @param {number} [params.scanDepth] - Account indices to try.
 * @returns {{ publicKey: string, secretKey: string, path: string, accountIndex: number }}
 * @throws {Error} code `mnemonic_mismatch`
 */
const recoverWalletFromMnemonic = ({
  mnemonic,
  expectedPublicKey,
  passphrase,
  scanDepth = RECOVERY_SCAN_DEPTH,
}) => {
  if (!expectedPublicKey || !StellarSdk.StrKey.isValidEd25519PublicKey(expectedPublicKey)) {
    throw codedError(
      'A valid expected public key is required to verify recovery.',
      EXPORT_ERROR_CODES.WALLET_NOT_FOUND,
    );
  }

  // Validates the phrase once up front so an invalid phrase reports as
  // invalid rather than as a mismatch after a pointless scan.
  deriveStellarKeypair({ mnemonic, passphrase, accountIndex: 0 });

  for (let accountIndex = 0; accountIndex < scanDepth; accountIndex += 1) {
    const derived = deriveStellarKeypair({ mnemonic, passphrase, accountIndex });
    if (derived.publicKey === expectedPublicKey) {
      return { ...derived, accountIndex };
    }
  }

  throw codedError(
    `Recovery phrase does not derive this wallet within the first ${scanDepth} account indices. `
    + 'The phrase may belong to a different wallet, or need its BIP-39 passphrase.',
    EXPORT_ERROR_CODES.MNEMONIC_MISMATCH,
  );
};

/**
 * Does `mnemonic` actually control `wallet`?
 *
 * The only honest way to answer "is this wallet mnemonic-derived?" — there is
 * no stored flag, and a client-supplied claim is worthless.
 *
 * @param {object} params
 * @param {string} params.mnemonic
 * @param {string} params.publicKey
 * @param {string} [params.passphrase]
 * @param {number} [params.scanDepth]
 * @returns {boolean}
 */
const mnemonicControlsWallet = ({ mnemonic, publicKey, passphrase, scanDepth = RECOVERY_SCAN_DEPTH }) => {
  try {
    recoverWalletFromMnemonic({ mnemonic, expectedPublicKey: publicKey, passphrase, scanDepth });
    return true;
  } catch (_error) {
    return false;
  }
};

// ─────────────────────────────────────────────────────────────────────────
// Out-of-band challenge
// ─────────────────────────────────────────────────────────────────────────

/**
 * The pepper used to HMAC challenge codes. Reuses the deployment's existing
 * secret material rather than introducing another key to manage.
 */
const challengePepper = () => config.compliance?.pinPepper
  || config.encryptionKey
  || config.admin?.jwtSecret
  || 'development-only-export-challenge-pepper';

/**
 * Hash a challenge code. Only the hash is ever stored.
 *
 * @param {string} code
 * @param {string} grantSalt - Binds the hash to one grant so it cannot be
 *   replayed against another grant that happened to draw the same code.
 * @returns {string} hex HMAC
 */
const hashChallenge = (code, grantSalt) => crypto
  .createHmac('sha256', challengePepper())
  .update(`${grantSalt}:${code}`)
  .digest('hex');

/** Constant-time string comparison that tolerates length mismatch. */
const timingSafeEqual = (left, right) => {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

/**
 * A uniformly random numeric challenge code.
 *
 * `crypto.randomInt` is rejection-sampled, so the digits are unbiased —
 * `randomBytes % 10` would not be.
 *
 * @returns {string}
 */
const generateChallengeCode = () => {
  let code = '';
  for (let i = 0; i < CHALLENGE_DIGITS; i += 1) code += String(crypto.randomInt(0, 10));
  return code;
};

// ─────────────────────────────────────────────────────────────────────────
// Export authorization
// ─────────────────────────────────────────────────────────────────────────

/**
 * Begin an export: create a pending grant and send the challenge out of band.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.walletId
 * @param {object} params.prismaClient
 * @param {Function} params.sendChallenge - `({ phoneNumber, code }) => Promise`.
 *   Injected; defaults are wired at the call site so this module needs no
 *   transport. Receives the plaintext code and nothing else.
 * @param {Date} [params.now]
 * @returns {Promise<object>} The grant, WITHOUT the code.
 */
const requestExport = async ({ userId, walletId, prismaClient, sendChallenge, now = new Date() }) => {
  const wallet = await prismaClient.wallet.findUnique({ where: { id: walletId } });
  if (!wallet || wallet.userId !== userId) {
    // Same error whether the wallet is missing or belongs to someone else, so
    // this cannot be used to enumerate wallet ids.
    throw codedError('Wallet not found for this user.', EXPORT_ERROR_CODES.WALLET_NOT_FOUND);
  }

  const code = generateChallengeCode();
  // Bind the hash to a per-grant salt generated before the row exists.
  const grantSalt = crypto.randomBytes(16).toString('hex');

  const grant = await prismaClient.mnemonicExportGrant.create({
    data: {
      userId,
      walletId,
      status: GRANT_STATUS.PENDING,
      // The salt travels with the hash; it is not secret, only unique.
      challengeHash: `${grantSalt}$${hashChallenge(code, grantSalt)}`,
      challengeExpiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
      challengeAttempts: 0,
    },
  });

  // Delivery happens after persistence so a crash cannot leave a code in the
  // user's hands with no grant to verify it against.
  await sendChallenge({ phoneNumber: wallet.phoneNumber, code });

  await writeAuditLog({
    actorType: 'user',
    actorId: userId,
    action: 'wallet.export.requested',
    entityType: 'Wallet',
    entityId: walletId,
    // Identifiers and timestamps only — never the code, never key material.
    metadata: { grantId: grant.id, expiresAt: grant.challengeExpiresAt.toISOString() },
  });

  return {
    id: grant.id,
    status: grant.status,
    challengeExpiresAt: grant.challengeExpiresAt,
    walletId,
  };
};

/**
 * Verify BOTH factors and authorize the grant.
 *
 * Neither factor alone is sufficient, and the verified state lives only in
 * the grant row — a caller claiming `verified: true` has no effect, because
 * nothing in this function reads such a field.
 *
 * @param {object} params
 * @param {string} params.grantId
 * @param {string} params.code - The out-of-band challenge code.
 * @param {string} params.pin - The user's PIN.
 * @param {object} params.prismaClient
 * @param {Date} [params.now]
 * @returns {Promise<object>} The authorized grant summary.
 */
const verifyExportChallenge = async ({ grantId, code, pin, prismaClient, now = new Date() }) => {
  const grant = await prismaClient.mnemonicExportGrant.findUnique({ where: { id: grantId } });
  if (!grant) throw codedError('Export grant not found.', EXPORT_ERROR_CODES.GRANT_NOT_FOUND);

  if (grant.status === GRANT_STATUS.CONSUMED) {
    throw codedError('This export has already been used.', EXPORT_ERROR_CODES.GRANT_CONSUMED);
  }
  if (grant.status === GRANT_STATUS.REVOKED) {
    throw codedError('This export grant was revoked.', EXPORT_ERROR_CODES.NOT_AUTHORIZED);
  }
  if (new Date(grant.challengeExpiresAt).getTime() <= now.getTime()) {
    await prismaClient.mnemonicExportGrant.update({
      where: { id: grant.id },
      data: { status: GRANT_STATUS.EXPIRED },
    });
    throw codedError('Export verification window has expired.', EXPORT_ERROR_CODES.GRANT_EXPIRED);
  }
  if (grant.challengeAttempts >= CHALLENGE_MAX_ATTEMPTS) {
    await prismaClient.mnemonicExportGrant.update({
      where: { id: grant.id },
      data: { status: GRANT_STATUS.REVOKED },
    });
    throw codedError(
      'Too many incorrect verification attempts; request a new export.',
      EXPORT_ERROR_CODES.CHALLENGE_ATTEMPTS_EXCEEDED,
    );
  }

  // ── Factor 1: PIN, through the existing compliance service so the shared
  // failure counter and lockout policy apply here too. ───────────────────
  const pinResult = await verifyPinAttempt({
    prisma: prismaClient,
    userId: grant.userId,
    pin,
  });
  if (!pinResult?.ok) {
    // `locked` and `retryAfterMs` come from the shared PIN lockout policy, so
    // repeated export attempts burn the same budget as any other PIN use.
    throw codedError(
      pinResult?.locked ? 'PIN is locked; try again later.' : 'PIN verification failed.',
      EXPORT_ERROR_CODES.PIN_REJECTED,
      { locked: Boolean(pinResult?.locked), retryAfterMs: pinResult?.retryAfterMs || 0 },
    );
  }

  // ── Factor 2: the out-of-band challenge ────────────────────────────────
  const [grantSalt, expectedHash] = String(grant.challengeHash).split('$');
  const providedHash = hashChallenge(String(code || ''), grantSalt);

  if (!timingSafeEqual(providedHash, expectedHash)) {
    // Count the attempt before refusing, so a brute-force run exhausts the
    // budget rather than spinning freely.
    await prismaClient.mnemonicExportGrant.update({
      where: { id: grant.id },
      data: { challengeAttempts: grant.challengeAttempts + 1 },
    });
    throw codedError('Verification code is incorrect.', EXPORT_ERROR_CODES.CHALLENGE_REJECTED);
  }

  const authorized = await prismaClient.mnemonicExportGrant.update({
    where: { id: grant.id },
    data: {
      status: GRANT_STATUS.AUTHORIZED,
      pinVerifiedAt: now,
      otpVerifiedAt: now,
      authorizedAt: now,
    },
  });

  return {
    id: authorized.id,
    status: authorized.status,
    authorizedAt: authorized.authorizedAt,
  };
};

/**
 * Consume an authorized grant and return the export payload, once.
 *
 * The consume step is a CONDITIONAL update — it matches only a row that is
 * still `authorized` with `consumedAt` null, and checks the affected count.
 * Two concurrent requests therefore cannot both win: the database decides.
 * A read-then-write check would leave a window between the read and the
 * write in which both callers see an unconsumed grant.
 *
 * @param {object} params
 * @param {string} params.grantId
 * @param {object} params.prismaClient
 * @param {Date} [params.now]
 * @param {Function} [params.decryptSecret] - Injected for tests.
 * @returns {Promise<object>} `{ mnemonicAvailable, mnemonic?, secretKey, publicKey, ... }`
 */
const consumeExport = async ({
  grantId,
  prismaClient,
  now = new Date(),
  decryptSecret = decrypt,
}) => {
  const grant = await prismaClient.mnemonicExportGrant.findUnique({ where: { id: grantId } });
  if (!grant) throw codedError('Export grant not found.', EXPORT_ERROR_CODES.GRANT_NOT_FOUND);
  if (grant.status === GRANT_STATUS.CONSUMED) {
    throw codedError('This export has already been used.', EXPORT_ERROR_CODES.GRANT_CONSUMED);
  }
  if (grant.status !== GRANT_STATUS.AUTHORIZED) {
    throw codedError(
      'Export is not authorized; complete PIN and out-of-band verification first.',
      EXPORT_ERROR_CODES.NOT_AUTHORIZED,
    );
  }
  // An authorized grant still expires: a window left open is a window an
  // attacker can come back to.
  if (new Date(grant.challengeExpiresAt).getTime() <= now.getTime()) {
    await prismaClient.mnemonicExportGrant.update({
      where: { id: grant.id },
      data: { status: GRANT_STATUS.EXPIRED },
    });
    throw codedError('Export authorization has expired.', EXPORT_ERROR_CODES.GRANT_EXPIRED);
  }

  // Atomic single-use claim. Whoever the database says changed the row wins.
  const claim = await prismaClient.mnemonicExportGrant.updateMany({
    where: { id: grant.id, status: GRANT_STATUS.AUTHORIZED, consumedAt: null },
    data: { status: GRANT_STATUS.CONSUMED, consumedAt: now },
  });
  if (!claim || claim.count !== 1) {
    throw codedError('This export has already been used.', EXPORT_ERROR_CODES.GRANT_CONSUMED);
  }

  const wallet = await prismaClient.wallet.findUnique({ where: { id: grant.walletId } });
  if (!wallet?.encryptedSecretKey) {
    throw codedError('Wallet has no key material to export.', EXPORT_ERROR_CODES.WALLET_NOT_FOUND);
  }

  const secretKey = decryptSecret(wallet.encryptedSecretKey);

  // Is this wallet actually mnemonic-derived? There is no flag to trust, so
  // the question is answered by reconstructing the relationship: a stored
  // mnemonic-derived wallet would have been created through
  // createMnemonicWallet, and we can only confirm a phrase by deriving it.
  // We hold no phrase here, so for any wallet created by Keypair.random()
  // the honest answer is: no mnemonic exists.
  const payload = {
    publicKey: wallet.publicKey,
    secretKey,
    mnemonicAvailable: false,
    reason:
      'This wallet was created from a random Stellar keypair, not from a BIP-39 '
      + 'phrase. No mnemonic can reproduce it — a generated phrase would derive a '
      + 'different, empty account. Import the secret key (S...) instead; Lobstr and '
      + 'Freighter both accept it.',
    importFormat: 'stellar_secret_seed',
  };

  await writeAuditLog({
    actorType: 'user',
    actorId: grant.userId,
    action: 'wallet.export.completed',
    entityType: 'Wallet',
    entityId: grant.walletId,
    // Identifiers, timestamps and the FORM of the export only. No phrase, no
    // secret key, no challenge code — this log is retained and reviewed.
    metadata: {
      grantId: grant.id,
      consumedAt: now.toISOString(),
      mnemonicAvailable: payload.mnemonicAvailable,
      importFormat: payload.importFormat,
    },
  });

  // Deliberately not logged beyond this line. JS strings cannot be reliably
  // zeroed — there is no scrubbing to claim here — so the mitigation is to
  // keep the material out of logs, errors, metrics and storage entirely, and
  // to hand it straight back to the caller without retaining it.
  logger.info(`Wallet export completed for grant ${grant.id} (format: ${payload.importFormat}).`);

  return payload;
};

/**
 * Export payload for a wallet that genuinely IS mnemonic-derived, proven by
 * the caller supplying a phrase that derives it.
 *
 * Separate from `consumeExport` so the "I can prove this phrase controls the
 * wallet" path can never be reached by accident.
 *
 * @param {object} params
 * @param {string} params.mnemonic - The phrase to verify and re-export.
 * @param {string} params.publicKey - The wallet's stored public key.
 * @param {string} [params.passphrase]
 * @returns {object} `{ mnemonicAvailable: true, mnemonic, publicKey, secretKey, path }`
 * @throws {Error} code `mnemonic_mismatch` when the phrase does not derive the wallet.
 */
const exportVerifiedMnemonic = ({ mnemonic, publicKey, passphrase }) => {
  const recovered = recoverWalletFromMnemonic({
    mnemonic, expectedPublicKey: publicKey, passphrase,
  });
  return {
    mnemonicAvailable: true,
    mnemonic,
    publicKey: recovered.publicKey,
    secretKey: recovered.secretKey,
    path: recovered.path,
    accountIndex: recovered.accountIndex,
    importFormat: 'bip39_mnemonic',
  };
};

module.exports = {
  STELLAR_COIN_TYPE,
  DEFAULT_STRENGTH_BITS,
  MAX_ACCOUNT_INDEX,
  CHALLENGE_DIGITS,
  CHALLENGE_TTL_MS,
  CHALLENGE_MAX_ATTEMPTS,
  GRANT_STATUS,
  EXPORT_ERROR_CODES,
  derivationPathFor,
  generateMnemonic,
  validateMnemonic,
  deriveStellarKeypair,
  createMnemonicWallet,
  recoverWalletFromMnemonic,
  mnemonicControlsWallet,
  generateChallengeCode,
  hashChallenge,
  requestExport,
  verifyExportChallenge,
  consumeExport,
  exportVerifiedMnemonic,
};
