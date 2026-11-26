'use strict';

// Multi-signature quorum policy for high-value transfers (#959).
//
// ── The problem ───────────────────────────────────────────────────────────
//
// Every outbound transfer today is signed by a single key. Whoever holds that
// key — or compromises the process that holds it — can move any amount. For
// transfers above the compliance threshold that is an unacceptable single
// point of failure, so this module requires a 2-of-3 quorum before such a
// transaction may be submitted.
//
// ── Where enforcement lives, and why it has to be here ───────────────────
//
// Authorization is enforced at the signing/submission boundary, server-side.
// A check in the frontend, in a controller, or anywhere before the envelope
// is built is advisory only: anything that can construct a transaction and
// reach Horizon bypasses it. `authorizeTransaction` is the gate, and
// `submitAuthorized` is structured so the submit callback is unreachable
// unless the gate returned — not merely "not called when it rejects", but
// lexically after a statement that throws.
//
// In production that boundary is `wallet/stellar.adapter.js#submitPayment`,
// which is the one function every USER-FACING outbound transfer goes through —
// the payment orchestrator, refunds, recurring payments and the SEP-6/SEP-31
// rails all end up there. It calls `authorizeForSubmission` AFTER the envelope
// is signed and BEFORE `server.submitTransaction`, so a refused transaction
// has already thrown by the time any transport exists.
//
// That is deliberately narrower than "every path that can reach Horizon", and
// the difference matters. Other modules call `server.submitTransaction`
// directly and this gate does NOT see them:
//
//   * `wallet/stellar.adapter.js#establishTrustline` and `wallet/trustlines.js`
//     (#962/#1066) submit `changeTrust` only, which moves no value and is
//     exempt on purpose (see ZERO_VALUE_OPERATIONS);
//   * `wallet/feeBump.js` and `wallet/channelAccountPool.js` are operational
//     plumbing;
//   * `wallet/hotWalletPool.js` (#1081) is NOT exempt. Its
//     `_executeMultisigTransfer` builds a native payment of arbitrary size
//     from cold storage, signs it with raw in-process keypairs up to its own
//     `coldStorageThreshold`, and submits directly. It applies its own notion
//     of a quorum, unrelated to this policy, and this gate cannot refuse it.
//
// Bringing that treasury path under one policy — or deciding that it is
// intentionally governed separately — is a maintainer decision, not something
// this module may assume. Do not restate the claim that all value-moving
// submissions are gated until it is true.
//
// Below the threshold nothing new runs at all — no extra Horizon read, no
// co-signer resolution, no verification. The ledger already enforces the
// account's own thresholds for ordinary transfers, and changing that would be
// a regression for the low-value flow the acceptance criteria require to keep
// working.
//
// ── What a real 2-of-3 check has to verify ───────────────────────────────
//
// Counting signatures is not verification. Four things must hold:
//
//  1. Each signature must cryptographically verify against *this*
//     transaction's hash. The hash commits to the network passphrase, so a
//     signature gathered on testnet cannot authorize the same operations on
//     mainnet, and a signature for a different transaction cannot be
//     replayed onto this one.
//  2. The signer must actually be a signer on the account, with the weight
//     the ledger says it has. We read `account.signers` and
//     `account.thresholds` from the Horizon account record rather than
//     inventing a parallel notion of "authorized".
//  3. The same signer must count at most once. Presenting one signer's
//     signature twice to reach weight 2 is the classic bypass.
//  4. The *total* value of the transaction decides the tier — not the largest
//     single operation. Splitting $2,000 into four $500 payments in one
//     envelope must still be high-tier.
//
// Decorated signature hints are only 4 bytes and CAN collide across keys, so
// a hint match narrows the candidates but never proves authorship. Every
// candidate is verified with the real Ed25519 check before it counts.
//
// ── Fail closed ──────────────────────────────────────────────────────────
//
// An operation type this module does not know how to value is treated as
// unbounded value, which forces the high tier and the full quorum. The
// alternative — treating an unrecognised operation as worth zero — means any
// future Stellar operation becomes a bypass. This is the single most
// important design decision in the file.

const StellarSdk = require('@stellar/stellar-sdk');

const config = require('../config/env');
const { add, compare } = require('../utils/money');

/**
 * Value above which a transfer requires the full quorum, in the platform's
 * accounting unit (USD-equivalent, matching the compliance threshold in the
 * issue). Read from the environment with the same idiom as the other policy
 * knobs (see compliance/pin.service.js), so a deployment can tighten it
 * without a code change.
 */
const highValueThreshold = () => String(
  process.env.MULTISIG_HIGH_VALUE_THRESHOLD
  || config.limits?.maxSendAmount
  || 1000,
);

/** Transfer tiers. `high` requires the quorum; `low` keeps single-key flow. */
const TRANSFER_TIERS = Object.freeze({ LOW: 'low', HIGH: 'high' });

/**
 * The intended on-chain arrangement: three signers of weight 1 each, with the
 * high threshold set to 2. Any two of the three can authorize a high-tier
 * operation and no single key can.
 */
const QUORUM_POLICY = Object.freeze({
  /** Signatures required for a high-tier transaction. */
  requiredWeight: 2,
  /** Total signers in the quorum. */
  signerCount: 3,
  roles: Object.freeze(['custody', 'compliance', 'operator']),
});

/** Stable error codes callers switch on. */
const MULTISIG_ERROR_CODES = Object.freeze({
  QUORUM_NOT_MET: 'quorum_not_met',
  UNAUTHORIZED_SIGNER: 'unauthorized_signer',
  INVALID_SIGNATURE: 'invalid_signature',
  DUPLICATE_SIGNATURE: 'duplicate_signature',
  NO_SIGNATURES: 'no_signatures',
  INVALID_ACCOUNT_RECORD: 'invalid_account_record',
  UNSUPPORTED_OPERATION: 'unsupported_operation',
});

/**
 * Operations that move value out of the source account and whose magnitude we
 * can read directly off the operation.
 *
 * `amount` is the field name holding the outbound value.
 */
const VALUED_OPERATIONS = Object.freeze({
  payment: 'amount',
  // For a strict-send path payment the account parts with sendAmount.
  pathPaymentStrictSend: 'sendAmount',
  // For strict-receive the most it can part with is sendMax.
  pathPaymentStrictReceive: 'sendMax',
  createAccount: 'startingBalance',
});

/**
 * Operations that move no value and are safe to treat as zero. Anything not
 * in this list and not in VALUED_OPERATIONS forces the high tier.
 */
const ZERO_VALUE_OPERATIONS = Object.freeze(new Set([
  'changeTrust',
  'setOptions',
  'manageData',
  'bumpSequence',
  'setTrustLineFlags',
  'allowTrust',
  'beginSponsoringFutureReserves',
  'endSponsoringFutureReserves',
]));

const codedError = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/**
 * Unwrap a fee-bump envelope to the transaction whose operations and
 * signatures actually matter.
 *
 * A fee bump changes WHO PAYS THE FEE. It does not waive the inner
 * transaction's own signature requirements, and it does not lower the
 * authorization needed for the inner operations. Evaluating the outer
 * envelope's (single, fee-payer) signature as if it authorized the inner
 * operations would be a complete bypass of this policy.
 *
 * @param {object} transaction - Transaction or FeeBumpTransaction.
 * @returns {{ inner: object, feeBumped: boolean }}
 */
const unwrapForPolicy = (transaction) => {
  if (!transaction) {
    throw codedError('A Stellar transaction is required.', MULTISIG_ERROR_CODES.INVALID_ACCOUNT_RECORD);
  }
  const isFeeBump = transaction instanceof StellarSdk.FeeBumpTransaction
    || Boolean(transaction.innerTransaction);
  return {
    inner: isFeeBump ? transaction.innerTransaction : transaction,
    feeBumped: isFeeBump,
  };
};

/**
 * Classify a transaction's value and tier.
 *
 * Pure: no I/O, no network. Sums outbound value per asset across ALL
 * operations so a split transfer cannot duck under the threshold, and fails
 * closed on any operation type it cannot value.
 *
 * @param {object} params
 * @param {object} params.transaction - Transaction or FeeBumpTransaction.
 * @param {string} [params.threshold] - Override the configured threshold.
 * @returns {{ tier: string, totalsByAsset: object, feeBumped: boolean,
 *            requiresQuorum: boolean, reasons: string[], unvalued: string[] }}
 */
const classifyTransaction = ({ transaction, threshold = highValueThreshold() }) => {
  const { inner, feeBumped } = unwrapForPolicy(transaction);
  const operations = inner.operations || [];

  const totalsByAsset = {};
  const reasons = [];
  const unvalued = [];

  for (const op of operations) {
    const amountField = VALUED_OPERATIONS[op.type];

    if (amountField) {
      // An operation may name its own `source`, moving value from an account
      // other than the transaction source. Record it so the caller can see
      // that the envelope spends from more than one account.
      if (op.source && op.source !== inner.source) {
        reasons.push(`operation ${op.type} overrides source to ${op.source}`);
      }

      const asset = op.asset || op.sendAsset || StellarSdk.Asset.native();
      const code = typeof asset.getCode === 'function'
        ? (asset.isNative() ? 'XLM' : asset.getCode())
        : String(asset);
      const raw = op[amountField];

      if (raw === undefined || raw === null) {
        // A valued operation with no readable amount is not safe to call zero.
        unvalued.push(op.type);
        reasons.push(`operation ${op.type} has no readable ${amountField}`);
        continue;
      }

      // Decimal string arithmetic, never floats: summing 7-decimal Stellar
      // amounts as JS Numbers drifts, and a policy threshold decided by a
      // drifting total is a policy that can be nudged across the line.
      totalsByAsset[code] = totalsByAsset[code]
        ? add(totalsByAsset[code], String(raw), code)
        : String(raw);
      continue;
    }

    if (ZERO_VALUE_OPERATIONS.has(op.type)) continue;

    // Fail closed. `accountMerge` lands here deliberately: it moves the
    // account's ENTIRE balance and carries no amount field, so it can never
    // be treated as a low-value operation.
    unvalued.push(op.type);
    reasons.push(
      `operation ${op.type} cannot be valued by this policy; treated as unbounded value`,
    );
  }

  // An unvaluable operation forces the quorum regardless of the totals.
  const failsClosed = unvalued.length > 0;

  const overThreshold = Object.entries(totalsByAsset).some(
    ([code, total]) => compare(total, threshold, code === 'XLM' ? 'XLM' : code) > 0,
  );

  const tier = failsClosed || overThreshold ? TRANSFER_TIERS.HIGH : TRANSFER_TIERS.LOW;

  if (overThreshold) reasons.push(`total value exceeds the ${threshold} high-value threshold`);

  return {
    tier,
    totalsByAsset,
    feeBumped,
    operations,
    requiresQuorum: tier === TRANSFER_TIERS.HIGH,
    reasons,
    unvalued,
  };
};

/**
 * The `setOptions` parameters an operator would apply to realise 2-of-3.
 *
 * Returned as reviewable DATA. Nothing here is submitted: changing signers
 * and thresholds on a custody account is an operator action requiring the
 * real keys, and this module never holds them.
 *
 * Weight arithmetic: three signers of weight 1, master weight 1 (so the
 * custody key is one of the three, not a superuser that could satisfy a
 * threshold of 2 alone).
 *   low  = 1  — single key still authorizes low-impact operations
 *   med  = 1  — preserves today's single-key behaviour for ordinary payments,
 *               which the application layer then raises to 2 for high-value
 *               transfers. Setting med = 2 on-chain would also force a second
 *               signature on every small payment, which the acceptance
 *               criteria explicitly require to keep working.
 *   high = 2  — any two of three for threshold changes and, via this module,
 *               high-value transfers.
 *
 * @param {object} params
 * @param {string[]} params.signers - The three signer public keys.
 * @returns {object} A reviewable plan; never submitted by this module.
 */
const buildThresholdPlan = ({ signers }) => {
  if (!Array.isArray(signers) || signers.length !== QUORUM_POLICY.signerCount) {
    throw codedError(
      `A ${QUORUM_POLICY.signerCount}-signer quorum needs exactly ${QUORUM_POLICY.signerCount} keys.`,
      MULTISIG_ERROR_CODES.INVALID_ACCOUNT_RECORD,
    );
  }
  const unique = new Set(signers);
  if (unique.size !== signers.length) {
    throw codedError('Quorum signers must be distinct keys.', MULTISIG_ERROR_CODES.DUPLICATE_SIGNATURE);
  }
  for (const key of signers) {
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(key)) {
      throw codedError(`Not a valid Stellar public key: ${key}`, MULTISIG_ERROR_CODES.UNAUTHORIZED_SIGNER);
    }
  }

  const [master, ...additional] = signers;

  return Object.freeze({
    /** The account the plan applies to — the first signer is the master key. */
    account: master,
    masterWeight: 1,
    /** Additional signers an operator adds with setOptions. */
    additionalSigners: additional.map((key) => ({ key, weight: 1, type: 'ed25519PublicKey' })),
    lowThreshold: 1,
    medThreshold: 1,
    highThreshold: QUORUM_POLICY.requiredWeight,
    /** Total weight available, which must exceed the high threshold. */
    totalWeight: signers.length,
    applied: false,
    note:
      'Reviewable plan only. Applying this requires the custody, compliance and '
      + 'operator keys and is an operator action; this module never submits it.',
  });
};

/**
 * Read the effective weight of each signer from a Horizon account record.
 *
 * @param {object} accountRecord - Horizon account record.
 * @returns {Map<string, number>} public key → weight (weight 0 signers dropped).
 */
const signerWeights = (accountRecord) => {
  const signers = accountRecord?.signers;
  if (!Array.isArray(signers)) {
    throw codedError(
      'Horizon account record is missing its signers array; cannot evaluate authorization.',
      MULTISIG_ERROR_CODES.INVALID_ACCOUNT_RECORD,
    );
  }

  const weights = new Map();
  for (const signer of signers) {
    const weight = Number(signer?.weight ?? 0);
    // A weight-0 signer has been revoked on-chain but may still appear.
    if (!signer?.key || !Number.isFinite(weight) || weight <= 0) continue;
    weights.set(signer.key, weight);
  }
  return weights;
};

/**
 * The threshold a tier must clear, taken from the account's own thresholds
 * where available so the ledger stays authoritative.
 *
 * @param {object} params
 * @param {object} params.accountRecord - Horizon account record.
 * @param {string} params.tier - TRANSFER_TIERS value.
 * @returns {number}
 */
const requiredWeightFor = ({ accountRecord, tier }) => {
  if (tier !== TRANSFER_TIERS.HIGH) {
    const low = Number(accountRecord?.thresholds?.low_threshold ?? 1);
    return Number.isFinite(low) && low > 0 ? low : 1;
  }
  // High tier: the application policy floor is 2-of-3, and if the account's
  // own high threshold is stricter we honour the stricter value.
  const high = Number(accountRecord?.thresholds?.high_threshold ?? 0);
  return Math.max(QUORUM_POLICY.requiredWeight, Number.isFinite(high) ? high : 0);
};

/**
 * Cryptographically verify a transaction's signatures against an account's
 * signer set.
 *
 * @param {object} params
 * @param {object} params.transaction - Transaction (fee bumps are unwrapped).
 * @param {object} params.accountRecord - Horizon account record.
 * @param {string} params.networkPassphrase - The network the signatures must bind to.
 * @returns {{ validSigners: string[], totalWeight: number, duplicates: string[],
 *             unauthorized: number, invalid: number }}
 */
const verifySignatures = ({ transaction, accountRecord, networkPassphrase }) => {
  const { inner } = unwrapForPolicy(transaction);
  const weights = signerWeights(accountRecord);

  // The hash commits to the network passphrase. Rebuilding it here — rather
  // than trusting a hash handed to us — is what makes a cross-network or
  // cross-transaction signature fail.
  const envelope = inner.toEnvelope();
  const rebuilt = new StellarSdk.Transaction(envelope, networkPassphrase);
  const hash = rebuilt.hash();

  const signatures = inner.signatures || [];

  const validSigners = [];
  const seen = new Set();
  const duplicates = [];
  let invalid = 0;
  let unauthorized = 0;

  for (const decorated of signatures) {
    const sigBytes = decorated.signature();
    const hint = decorated.hint();

    // The 4-byte hint narrows which signers could have produced this
    // signature. Hints can collide, so it is only a filter — authorship is
    // decided by the Ed25519 verification below, never by the hint.
    let matched = null;
    for (const key of weights.keys()) {
      const keypair = StellarSdk.Keypair.fromPublicKey(key);
      const keyHint = keypair.signatureHint();
      if (!keyHint.equals(hint)) continue;
      if (keypair.verify(hash, sigBytes)) {
        matched = key;
        break;
      }
    }

    if (!matched) {
      // Either the signature does not verify for any account signer, or it
      // belongs to a key that is not a signer at all. Distinguish the two for
      // diagnostics by checking whether ANY signer's hint matched.
      const hintKnown = [...weights.keys()].some(
        (key) => StellarSdk.Keypair.fromPublicKey(key).signatureHint().equals(hint),
      );
      if (hintKnown) invalid += 1;
      else unauthorized += 1;
      continue;
    }

    if (seen.has(matched)) {
      // One signer, two signatures. Counting it twice is exactly how a
      // single compromised key would fake a 2-of-3 quorum.
      duplicates.push(matched);
      continue;
    }

    seen.add(matched);
    validSigners.push(matched);
  }

  const totalWeight = validSigners.reduce((sum, key) => sum + (weights.get(key) || 0), 0);

  return { validSigners, totalWeight, duplicates, unauthorized, invalid };
};

/**
 * The authorization gate. Throws unless the transaction may be submitted.
 *
 * @param {object} params
 * @param {object} params.transaction - Transaction or FeeBumpTransaction.
 * @param {object} params.accountRecord - Horizon account record for the source.
 * @param {string} params.networkPassphrase - Network the signatures must bind to.
 * @param {string} [params.threshold] - Override the high-value threshold.
 * @returns {object} `{ authorized: true, tier, totalWeight, requiredWeight, ... }`
 * @throws {Error} with a `code` from MULTISIG_ERROR_CODES.
 */
const authorizeTransaction = ({
  transaction,
  accountRecord,
  networkPassphrase,
  threshold = highValueThreshold(),
}) => {
  const classification = classifyTransaction({ transaction, threshold });
  const verification = verifySignatures({ transaction, accountRecord, networkPassphrase });
  const requiredWeight = requiredWeightFor({ accountRecord, tier: classification.tier });

  if (verification.validSigners.length === 0) {
    throw codedError(
      'Transaction carries no signature that verifies against this account on this network.',
      MULTISIG_ERROR_CODES.NO_SIGNATURES,
      { tier: classification.tier, requiredWeight },
    );
  }

  if (verification.totalWeight < requiredWeight) {
    // One message for every way of falling short, so the failure mode is not
    // leaked back to a caller probing the policy. Details stay in the fields.
    const code = classification.tier === TRANSFER_TIERS.HIGH
      ? MULTISIG_ERROR_CODES.QUORUM_NOT_MET
      : MULTISIG_ERROR_CODES.UNAUTHORIZED_SIGNER;
    throw codedError(
      `Authorization weight ${verification.totalWeight} is below the ${requiredWeight} `
      + `required for a ${classification.tier}-value transfer.`,
      code,
      {
        tier: classification.tier,
        requiredWeight,
        totalWeight: verification.totalWeight,
        duplicates: verification.duplicates,
        unauthorized: verification.unauthorized,
        invalid: verification.invalid,
        reasons: classification.reasons,
      },
    );
  }

  return {
    authorized: true,
    tier: classification.tier,
    requiredWeight,
    totalWeight: verification.totalWeight,
    validSigners: verification.validSigners,
    totalsByAsset: classification.totalsByAsset,
    feeBumped: classification.feeBumped,
    reasons: classification.reasons,
  };
};

/**
 * Submit only if the quorum policy authorizes the transaction.
 *
 * `submit` is injected so the gate is testable and so no transport is wired
 * into the policy. The gate throws before `submit` is referenced, so a
 * refused transaction cannot reach the network by any path through this
 * function.
 *
 * @param {object} params
 * @param {object} params.transaction - Transaction or FeeBumpTransaction.
 * @param {object} params.accountRecord - Horizon account record.
 * @param {string} params.networkPassphrase - Network passphrase.
 * @param {Function} params.submit - `(transaction) => Promise<any>`.
 * @param {string} [params.threshold] - Override the high-value threshold.
 * @returns {Promise<object>} `{ authorization, result }`
 */
const submitAuthorized = async ({
  transaction,
  accountRecord,
  networkPassphrase,
  submit,
  threshold = highValueThreshold(),
}) => {
  // Throws on refusal. Nothing below runs unless authorization succeeded.
  const authorization = authorizeTransaction({
    transaction, accountRecord, networkPassphrase, threshold,
  });

  if (typeof submit !== 'function') {
    throw codedError('A submit function is required.', MULTISIG_ERROR_CODES.INVALID_ACCOUNT_RECORD);
  }

  const result = await submit(transaction);
  return { authorization, result };
};

// ── Getting the second signature ───────────────────────────────────────────
//
// A policy that can only REFUSE is half a feature: refusing every high-value
// transfer forever is safe but useless. The second signature has to come from
// somewhere, so this section defines where: the quorum co-signers configured
// for the deployment (the platform compliance signer and/or the operator
// signer), each of which is asked — over the same hash-based protocol the HSM
// signer already speaks — to co-sign the exact envelope being submitted.
//
// Three rules keep this honest:
//
//  1. A co-signer is only ever ASKED, never trusted. Its reply is verified
//     with Ed25519 against the transaction hash before it is attached, and
//     `authorizeTransaction` then re-verifies the whole envelope against the
//     ledger's own signer set. A co-signer that signs something else, returns
//     garbage, or is not actually a signer on the account cannot move the
//     transaction one step closer to submission.
//  2. Nothing is configured, or the configuration is unusable ⇒ high-value
//     transfers are refused. Fail closed, with a stable code an operator can
//     act on, and never a silent downgrade to single-key submission.
//  3. Co-signers are resolved LAZILY, only once a transaction is known to be
//     high tier. A broken co-signer configuration must not be able to break a
//     $10 payment.
//
// The co-signers themselves are only reachable if the account actually has
// those keys on-chain, which is an operator action this module deliberately
// never performs (see `buildThresholdPlan`). Until then, `MULTISIG_COSIGNERS`
// is unset and every high-value transfer fails closed with
// `cosigner_unavailable`.

const COSIGNER_ERROR_CODES = Object.freeze({
  /** No co-signer configured, so a second signature can never be obtained. */
  COSIGNER_UNAVAILABLE: 'cosigner_unavailable',
  /** `MULTISIG_COSIGNERS` / `MULTISIG_COSIGNER_ENDPOINT` cannot be used. */
  COSIGNER_MISCONFIGURED: 'cosigner_misconfigured',
  /** A configured co-signer was reached but did not produce a signature. */
  COSIGNER_FAILED: 'cosigner_failed',
  /** A co-signer replied with something that is not a valid signature. */
  INVALID_COSIGNER_SIGNATURE: 'invalid_cosigner_signature',
});

const SIGNATURE_BYTES = 64;

/**
 * Normalize whatever a co-signer handed back into the base64 form
 * `addSignature` expects. Returns `null` unless the result is exactly 64
 * bytes — a length check is the cheapest way to reject a truncated or
 * padded-to-garbage reply before any cryptography runs.
 *
 * @param {Buffer|Uint8Array|string} raw
 * @returns {string|null} base64 signature, or null if unusable.
 */
const toSignatureBase64 = (raw) => {
  let bytes = null;
  if (Buffer.isBuffer(raw)) bytes = raw;
  else if (raw instanceof Uint8Array) bytes = Buffer.from(raw);
  else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^[0-9a-fA-F]{128}$/.test(trimmed)) bytes = Buffer.from(trimmed, 'hex');
    else bytes = Buffer.from(trimmed, 'base64');
  }
  if (!bytes || bytes.length !== SIGNATURE_BYTES) return null;
  return bytes.toString('base64');
};

/**
 * Parse one `MULTISIG_COSIGNERS` entry: either `<keyId>=<publicKey>` or a bare
 * `<publicKey>`.
 *
 * @param {string} spec
 * @returns {{keyId: string, publicKey: string}|null} null for a blank entry.
 * @throws {Error} code `cosigner_misconfigured` for a malformed key.
 */
const parseCoSignerSpec = (spec) => {
  const raw = String(spec ?? '').trim();
  if (!raw) return null;
  const separator = raw.indexOf('=');
  const keyId = separator > 0 ? raw.slice(0, separator).trim() : null;
  const publicKey = separator > 0 ? raw.slice(separator + 1).trim() : raw;
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(publicKey)) {
    throw codedError(
      'MULTISIG_COSIGNERS contains an entry that is not a valid Stellar public key.',
      COSIGNER_ERROR_CODES.COSIGNER_MISCONFIGURED,
      { entry: keyId || 'unknown' },
    );
  }
  return { keyId: keyId || publicKey, publicKey };
};

/**
 * Test/ops override for the co-signer list. `undefined` restores the
 * environment-derived list; `null` (or `[]`) pins the list to "none".
 *
 * @param {Array<object>|null|undefined} coSigners
 */
let coSignerOverride;
const setCoSigners = (coSigners) => {
  coSignerOverride = coSigners === undefined ? undefined : coSigners;
};

let cachedCoSignerClient = { endpoint: null, apiKey: null, client: null };

/**
 * Build (and memoize) the remote signing client the co-signers share. Uses
 * `hsmSigner` so the co-signing protocol is the same one already reviewed and
 * tested: a 32-byte hash in, a 64-byte Ed25519 signature out.
 *
 * @returns {object} an HSM signer client.
 * @throws {Error} code `cosigner_misconfigured` when no endpoint is configured.
 */
const resolveCoSignerClient = () => {
  const endpoint = String(process.env.MULTISIG_COSIGNER_ENDPOINT || '').trim();
  const apiKey = process.env.MULTISIG_COSIGNER_API_KEY
    || process.env.HSM_API_KEY
    || undefined;

  if (!endpoint) {
    throw codedError(
      'MULTISIG_COSIGNERS is set but MULTISIG_COSIGNER_ENDPOINT is empty; '
      + 'there is no way to obtain a second signature.',
      COSIGNER_ERROR_CODES.COSIGNER_MISCONFIGURED,
    );
  }
  if (cachedCoSignerClient.endpoint === endpoint && cachedCoSignerClient.apiKey === apiKey) {
    return cachedCoSignerClient.client;
  }
  // Lazy require: `hsmSigner` pulls in the HTTP client, and a deployment that
  // never configures co-signers should never load it.
  const { createHsmSigner } = require('./hsmSigner');
  const client = createHsmSigner({ endpoint, apiKey });
  cachedCoSignerClient = { endpoint, apiKey, client };
  return client;
};

/**
 * The quorum co-signers configured for this deployment.
 *
 * @returns {Array<{keyId: string, publicKey: string, signHash: Function}>}
 *          Empty when nothing is configured — callers must treat that as
 *          "high-tier transfers are unavailable", not as "approve them".
 * @throws {Error} code `cosigner_misconfigured` when the configuration exists
 *         but cannot be used.
 */
const configuredCoSigners = () => {
  if (coSignerOverride !== undefined) return coSignerOverride;

  const raw = String(process.env.MULTISIG_COSIGNERS || '').trim();
  if (!raw) return [];

  const specs = raw.split(',').map(parseCoSignerSpec).filter(Boolean);
  if (specs.length === 0) return [];

  const client = resolveCoSignerClient();
  return specs.map((spec) => ({
    keyId: spec.keyId,
    publicKey: spec.publicKey,
    signHash: ({ hash, transaction } = {}) => client.signHash({
      keyId: spec.keyId,
      publicKey: spec.publicKey,
      hash,
      ...(transaction ? { context: { transactionHash: transaction.hash().toString('hex') } } : {}),
    }),
  }));
};

/**
 * Collect whatever extra signatures a high-tier transaction still needs, then
 * authorize it.
 *
 * Does nothing at all — no co-signer is resolved, no signature is requested —
 * when the transaction is below the threshold, so a broken co-signer
 * configuration can never affect an ordinary payment.
 *
 * @param {object} params
 * @param {object} params.transaction - Transaction or FeeBumpTransaction.
 * @param {object} params.accountRecord - Horizon account record (signers + thresholds).
 * @param {string} params.networkPassphrase - Network the signatures must bind to.
 * @param {string} [params.threshold] - Override the high-value threshold.
 * @param {Array<object>} [params.coSigners] - Co-signers to consult.
 * @returns {Promise<object>} `{ tier, quorumRequired, requiredWeight, requested, attached, weight }`
 * @throws {Error} with a `code` from COSIGNER_ERROR_CODES or MULTISIG_ERROR_CODES.
 */
const collectQuorumSignatures = async ({
  transaction,
  accountRecord,
  networkPassphrase,
  threshold = highValueThreshold(),
  coSigners = [],
}) => {
  const classification = classifyTransaction({ transaction, threshold });

  if (!classification.requiresQuorum) {
    return {
      tier: classification.tier,
      quorumRequired: false,
      requested: [],
      attached: [],
    };
  }

  if (!Array.isArray(coSigners) || coSigners.length === 0) {
    throw codedError(
      'High-value transfer refused: no quorum co-signer is configured, so a second '
      + 'signature can never be obtained.',
      COSIGNER_ERROR_CODES.COSIGNER_UNAVAILABLE,
      { tier: classification.tier, reasons: classification.reasons },
    );
  }

  // Throws when the account record has no signers array: an unknown signer set
  // must never be treated as an open door.
  const weights = signerWeights(accountRecord);
  const requiredWeight = requiredWeightFor({ accountRecord, tier: classification.tier });
  const starting = verifySignatures({ transaction, accountRecord, networkPassphrase });

  const { inner } = unwrapForPolicy(transaction);
  const hash = inner.hash();

  const signed = new Set(starting.validSigners);
  const requested = [];
  const attached = [];
  let weight = starting.totalWeight;

  for (const coSigner of coSigners) {
    if (weight >= requiredWeight) break;
    if (!coSigner || typeof coSigner.signHash !== 'function') continue;

    const publicKey = String(coSigner.publicKey || '');
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(publicKey)) {
      throw codedError(
        'A configured quorum co-signer does not name a valid Stellar public key.',
        COSIGNER_ERROR_CODES.COSIGNER_MISCONFIGURED,
        { tier: classification.tier },
      );
    }
    if (!weights.has(publicKey)) {
      // The ledger is authoritative: a key that is not a signer on this
      // account can never contribute weight, so asking it is a configuration
      // mistake worth surfacing rather than quietly burning time on.
      throw codedError(
        `Quorum co-signer ${coSigner.keyId || 'unknown'} is not a signer on this account, `
        + 'so its signature can never satisfy the quorum.',
        COSIGNER_ERROR_CODES.COSIGNER_MISCONFIGURED,
        { tier: classification.tier },
      );
    }
    if (signed.has(publicKey)) continue;

    requested.push(publicKey);
    let raw;
    try {
      raw = await coSigner.signHash({ keyId: coSigner.keyId, publicKey, hash, transaction: inner });
    } catch (error) {
      throw codedError(
        `Quorum co-signer ${coSigner.keyId || publicKey} did not produce a signature: `
        + `${error?.code || error?.message || 'signing failed'}`,
        COSIGNER_ERROR_CODES.COSIGNER_FAILED,
        { tier: classification.tier },
      );
    }

    const base64 = toSignatureBase64(raw);
    if (!base64) {
      throw codedError(
        `Quorum co-signer ${coSigner.keyId || publicKey} returned a value that is not a `
        + `${SIGNATURE_BYTES}-byte Ed25519 signature.`,
        COSIGNER_ERROR_CODES.INVALID_COSIGNER_SIGNATURE,
        { tier: classification.tier },
      );
    }
    try {
      // `addSignature` verifies Ed25519 against this transaction's hash before
      // it attaches anything, so a co-signer that signed a different envelope
      // is rejected here instead of being counted.
      inner.addSignature(publicKey, base64);
    } catch (_error) {
      throw codedError(
        `Quorum co-signer ${coSigner.keyId || publicKey} returned a signature that does not `
        + 'verify for this transaction.',
        COSIGNER_ERROR_CODES.INVALID_COSIGNER_SIGNATURE,
        { tier: classification.tier },
      );
    }

    signed.add(publicKey);
    attached.push(publicKey);
    weight += weights.get(publicKey) || 0;
  }

  return {
    tier: classification.tier,
    quorumRequired: true,
    requiredWeight,
    requested,
    attached,
    weight,
  };
};

/**
 * The submission gate: make sure the envelope in front of you is one this
 * policy allows on the wire, collecting the co-signatures it is missing first.
 *
 * This is the function `stellar.adapter.submitPayment` calls between signing
 * and submitting. It throws — always, and before any transport is touched —
 * when the transaction may not be submitted.
 *
 * @param {object} params
 * @param {object} params.transaction - Transaction or FeeBumpTransaction.
 * @param {object} params.accountRecord - Horizon account record for the source.
 * @param {string} params.networkPassphrase - Network the signatures must bind to.
 * @param {string} [params.threshold] - Override the high-value threshold.
 * @param {Function} [params.resolveCoSigners] - Lazily supplies the co-signers.
 * @returns {Promise<object>} Authorization detail; `quorumRequired` says which
 *          branch ran.
 * @throws {Error} with a `code` from MULTISIG_ERROR_CODES or COSIGNER_ERROR_CODES.
 */
const authorizeForSubmission = async ({
  transaction,
  accountRecord,
  networkPassphrase,
  threshold = highValueThreshold(),
  resolveCoSigners = configuredCoSigners,
}) => {
  const classification = classifyTransaction({ transaction, threshold });

  if (!classification.requiresQuorum) {
    // Deliberately NOT run through `authorizeTransaction`: below the threshold
    // the account's own on-chain thresholds govern, exactly as they did before
    // this policy existed, and the ledger rejects an under-signed envelope on
    // its own. The application only raises the bar above the threshold — which
    // is also why a broken co-signer configuration can never break this path.
    return {
      authorized: true,
      quorumRequired: false,
      tier: classification.tier,
      totalsByAsset: classification.totalsByAsset,
      feeBumped: classification.feeBumped,
      reasons: classification.reasons,
      note: 'At or below the high-value threshold; the account\'s on-chain thresholds govern.',
    };
  }

  // Everything this branch throws is a refusal that happened BEFORE any
  // transport existed, so it is tagged `preSubmission`. Callers that unwind a
  // failed payment need that distinction: an error raised after submission
  // started may correspond to a transaction that is actually on the network
  // and must be reversed by the reversal job, whereas a refusal here moved
  // nothing and the caller still owns every reservation it took. Without the
  // tag the payment orchestrator treats the refusal as post-submission and
  // leaks the velocity reservation, because `handleStellarPaymentFailure`
  // only enqueues a reversal for genuine Horizon rejections.
  try {
    const coSigners = await resolveCoSigners();

    const collection = await collectQuorumSignatures({
      transaction,
      accountRecord,
      networkPassphrase,
      threshold,
      coSigners,
    });

    const authorization = authorizeTransaction({
      transaction, accountRecord, networkPassphrase, threshold,
    });

    return { ...authorization, quorumRequired: true, coSignerCollection: collection };
  } catch (error) {
    if (error && typeof error === 'object') error.preSubmission = true;
    throw error;
  }
};

module.exports = {
  TRANSFER_TIERS,
  QUORUM_POLICY,
  MULTISIG_ERROR_CODES,
  COSIGNER_ERROR_CODES,
  VALUED_OPERATIONS,
  ZERO_VALUE_OPERATIONS,
  highValueThreshold,
  unwrapForPolicy,
  classifyTransaction,
  buildThresholdPlan,
  signerWeights,
  requiredWeightFor,
  verifySignatures,
  authorizeTransaction,
  submitAuthorized,
  parseCoSignerSpec,
  toSignatureBase64,
  setCoSigners,
  configuredCoSigners,
  collectQuorumSignatures,
  authorizeForSubmission,
};
