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

module.exports = {
  TRANSFER_TIERS,
  QUORUM_POLICY,
  MULTISIG_ERROR_CODES,
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
};
