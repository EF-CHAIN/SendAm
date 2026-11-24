'use strict';

// Automatic trustline establishment for asset corridors (#962).
//
// ── Why this exists ──────────────────────────────────────────────────────
//
// A Stellar account cannot hold an issued asset until it has a trustline to
// that asset's issuer. Send USDC to an account with no USDC trustline and the
// payment fails outright. So before the first transfer of any issued asset to
// a user, the trustline has to be there — and establishing it is itself a
// signed, fee-paying, reserve-consuming ledger operation.
//
// ── Identity, not asset code ─────────────────────────────────────────────
//
// A trustline is to an (asset code, issuer) PAIR. Anyone can issue a token
// called "USDC", so a balance line whose `asset_code` is "USDC" proves
// nothing on its own. `hasTrustline` matches code AND issuer, and every asset
// here is resolved through `assetIdentity`, which owns the canonical
// (network, code, issuer) triple. A same-code trustline to an unrecognised
// issuer is treated as NOT having the trustline, because holding a worthless
// look-alike token is not the same as being able to receive the real asset.
//
// ── Two things a fee bump does not do ────────────────────────────────────
//
// The issue's scope says "submit ChangeTrustOperation with fee-bump", and it
// is easy to over-read that. A fee-bump transaction changes WHO PAYS THE FEE.
// It does NOT:
//
//   1. waive the inner transaction's signature requirements — a ChangeTrust
//      operation's source is the trustor, and only the trustor's signer can
//      authorize it. A platform fee-payer cannot open a trustline on an
//      account it does not hold a key for; and
//   2. waive the base reserve. Each trustline is a subentry that raises the
//      account's minimum XLM balance by one base reserve. A fee bump pays
//      fees, not reserves.
//
// The Stellar mechanism that genuinely moves the reserve cost to another
// account is SPONSORED RESERVES
// (BeginSponsoringFutureReserves / EndSponsoringFutureReserves). That is a
// different feature and is NOT implemented here; `trustlineReserveRequirement`
// still refuses when the trustor cannot cover the subentry, and a test
// asserts that supplying a fee-bump sponsor does not change that answer.
//
// ── Not claiming what we cannot do ───────────────────────────────────────
//
// If no signer is available for the trustor, this module refuses rather than
// reporting success it cannot deliver. `ensureTrustline` never reports
// `established` for an operation it did not actually land or confirm.

const StellarSdk = require('@stellar/stellar-sdk');

const assetIdentity = require('./assetIdentity');
const config = require('../config/env');
const logger = require('../utils/logger');
const { parseUnits, formatUnits, STELLAR_PRECISION } = require('../utils/money');

/** Prisma unique-constraint violation. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

/**
 * Standard Stellar base reserve, in stroops (0.5 XLM). Overridable because
 * the network can change it by protocol vote; callers should pass the live
 * value from Horizon when they have it.
 */
const DEFAULT_BASE_RESERVE_STROOPS = 5_000_000n;

/** Default fee estimate in stroops when a caller has no live base fee. */
const DEFAULT_FEE_STROOPS = 100n;

/**
 * The asset corridors this service supports (#962).
 *
 * Frozen policy data. Whether a corridor is actually AVAILABLE depends on
 * whether an issuer is configured for the active network — declaring a
 * corridor here does not conjure an issuer.
 */
const SUPPORTED_CORRIDORS = Object.freeze({
  USDC: Object.freeze({ code: 'USDC', label: 'US Dollar Coin', decimals: 7 }),
  EURC: Object.freeze({ code: 'EURC', label: 'Euro Coin', decimals: 7 }),
  NGNT: Object.freeze({ code: 'NGNT', label: 'Nigerian Naira Token', decimals: 7 }),
});

/** Trustline request lifecycle. */
const TRUSTLINE_STATUS = Object.freeze({
  PENDING: 'pending',
  SUBMITTED: 'submitted',
  ESTABLISHED: 'established',
  FAILED: 'failed',
});

/** Stable error/outcome codes. */
const TRUSTLINE_ERROR_CODES = Object.freeze({
  UNSUPPORTED_ASSET: 'unsupported_asset',
  ISSUER_NOT_CONFIGURED: 'issuer_not_configured',
  ISSUER_MISMATCH: 'issuer_mismatch',
  INSUFFICIENT_RESERVE: 'insufficient_reserve',
  ACCOUNT_NOT_FUNDED: 'account_not_funded',
  NO_SIGNER: 'no_signer',
  SUBMISSION_FAILED: 'submission_failed',
  SUBMISSION_UNCERTAIN: 'submission_uncertain',
});

const codedError = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/**
 * Resolve a corridor asset to its canonical identity on a network.
 *
 * @param {object} params
 * @param {string} params.code - Asset code, e.g. 'USDC'.
 * @param {string} params.network - Active Stellar network id.
 * @param {string} [params.expectedIssuer] - If given, must match the configured issuer.
 * @returns {{ code: string, issuer: string, assetId: string, asset: object }}
 * @throws {Error} `unsupported_asset`, `issuer_not_configured` or `issuer_mismatch`.
 */
const resolveCorridorAsset = ({ code, network, expectedIssuer }) => {
  const corridor = SUPPORTED_CORRIDORS[String(code || '').toUpperCase()];
  if (!corridor) {
    throw codedError(
      `${code} is not a supported asset corridor. Supported: ${Object.keys(SUPPORTED_CORRIDORS).join(', ')}.`,
      TRUSTLINE_ERROR_CODES.UNSUPPORTED_ASSET,
    );
  }

  const issuer = assetIdentity.resolveConfiguredIssuer({ network, code: corridor.code });
  if (!issuer) {
    // A declared corridor with no configured issuer on this network. Cleanly
    // unavailable — never "pick something plausible".
    throw codedError(
      `No ${corridor.code} issuer is configured for ${network}. `
      + 'Set the corresponding issuer environment variable before using this corridor.',
      TRUSTLINE_ERROR_CODES.ISSUER_NOT_CONFIGURED,
      // `assetCode`, not `code`: `code` is the error discriminator itself and
      // must not be shadowed by the asset's code.
      { assetCode: corridor.code, network },
    );
  }

  // A caller naming the right code but the wrong issuer is refused, not
  // silently "corrected" — they may be acting on attacker-supplied data.
  if (expectedIssuer && expectedIssuer !== issuer) {
    throw codedError(
      `${corridor.code} issuer does not match the issuer configured for ${network}.`,
      TRUSTLINE_ERROR_CODES.ISSUER_MISMATCH,
      { assetCode: corridor.code, network },
    );
  }

  return {
    code: corridor.code,
    issuer,
    assetId: assetIdentity.canonicalAssetKey({ network, code: corridor.code, issuer }),
    asset: new StellarSdk.Asset(corridor.code, issuer),
  };
};

/**
 * Which corridors are actually usable on a network right now.
 *
 * @param {string} network
 * @returns {Array<{ code: string, available: boolean, issuer: string|null, reason: string|null }>}
 */
const corridorAvailability = (network) => Object.values(SUPPORTED_CORRIDORS).map((corridor) => {
  const issuer = assetIdentity.resolveConfiguredIssuer({ network, code: corridor.code });
  return {
    code: corridor.code,
    label: corridor.label,
    available: Boolean(issuer),
    issuer: issuer || null,
    reason: issuer ? null : TRUSTLINE_ERROR_CODES.ISSUER_NOT_CONFIGURED,
  };
});

/**
 * Does this account already trust this exact asset identity?
 *
 * Matches code AND issuer. A same-code line from a different issuer is not a
 * match — that is the whole point of asset identity.
 *
 * @param {object} params
 * @param {object} params.accountRecord - Horizon account record with `balances`.
 * @param {string} params.code
 * @param {string} params.issuer
 * @returns {boolean}
 */
const hasTrustline = ({ accountRecord, code, issuer }) => {
  const balances = accountRecord?.balances;
  if (!Array.isArray(balances)) return false;
  return balances.some((b) => (
    b.asset_type !== 'native'
    && b.asset_code === code
    && b.asset_issuer === issuer
  ));
};

/** The account's native (XLM) balance in stroops. */
const nativeBalanceStroops = (accountRecord) => {
  const native = (accountRecord?.balances || []).find((b) => b.asset_type === 'native');
  if (!native) return 0n;
  return parseUnits(String(native.balance), STELLAR_PRECISION);
};

/**
 * Can this account afford one more subentry?
 *
 * Stellar's minimum balance is `(2 + subentryCount) * baseReserve`. Adding a
 * trustline adds one subentry, so the account must hold the new minimum plus
 * the transaction fee. All of it in BigInt stroops: floats cannot represent
 * 7-decimal XLM amounts exactly, and a rounding error here either blocks a
 * legitimate trustline or submits one that fails on-chain with op_low_reserve.
 *
 * @param {object} params
 * @param {object} params.accountRecord - Horizon account record.
 * @param {bigint|number|string} [params.baseReserveStroops]
 * @param {bigint|number|string} [params.feeStroops]
 * @param {number} [params.additionalSubentries=1]
 * @returns {{ sufficient: boolean, available: bigint, required: bigint, shortfall: bigint,
 *             balance: bigint, minimumBalance: bigint }}
 */
const trustlineReserveRequirement = ({
  accountRecord,
  baseReserveStroops = DEFAULT_BASE_RESERVE_STROOPS,
  feeStroops = DEFAULT_FEE_STROOPS,
  additionalSubentries = 1,
}) => {
  const reserve = BigInt(baseReserveStroops);
  const fee = BigInt(feeStroops);
  const balance = nativeBalanceStroops(accountRecord);
  const subentries = BigInt(accountRecord?.subentry_count ?? 0) + BigInt(additionalSubentries);

  // Base: every account reserves 2 base reserves, plus one per subentry.
  const minimumBalance = (2n + subentries) * reserve;
  const required = minimumBalance + fee;
  const available = balance - required;

  return {
    sufficient: available >= 0n,
    available,
    required,
    balance,
    minimumBalance,
    shortfall: available >= 0n ? 0n : -available,
    requiredXlm: formatUnits(required, STELLAR_PRECISION),
    balanceXlm: formatUnits(balance, STELLAR_PRECISION),
  };
};

/**
 * Is a Horizon submission failure UNCERTAIN (the operation may still land) or
 * definitively failed?
 *
 * A timeout or 5xx means we never learned the outcome: the ChangeTrust may
 * well be in the ledger. Marking that `failed` and resubmitting risks a
 * duplicate operation, so it is recorded as `submitted` for reconciliation.
 *
 * @param {Error} error
 * @returns {boolean}
 */
const isSubmissionUncertain = (error) => {
  const status = error?.response?.status ?? error?.status;
  if (status === 504 || status === 503 || status === 502 || status === 429) return true;
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|socket hang up/i.test(String(error?.message || ''))) {
    return true;
  }
  // Horizon reports a definitive transaction failure with result codes.
  const codes = error?.response?.data?.extras?.result_codes;
  return !codes;
};

/** Extract Horizon operation result codes, when present. */
const resultCodesOf = (error) => {
  const codes = error?.response?.data?.extras?.result_codes;
  if (!codes) return null;
  return [codes.transaction, ...(codes.operations || [])].filter(Boolean).join(',');
};

/**
 * Ensure a wallet trusts a corridor asset, submitting ChangeTrust if needed.
 *
 * Fully dependency-injected so tests need no network and no database.
 *
 * Duplicate suppression leans on the UNIQUE
 * (walletId, assetCode, assetIssuer) constraint rather than a read-then-write
 * "is there already a request?" check: between that read and its write,
 * another replica can insert the same row, and both callers would then submit
 * a ChangeTrust. Letting the database arbitrate makes the race impossible.
 *
 * @param {object} params
 * @param {object} params.wallet - Wallet row; needs `id` and `publicKey`.
 * @param {string} params.assetCode - Corridor code.
 * @param {object} params.horizon - Horizon client (`loadAccount`, `fetchBaseFee`).
 * @param {object} params.prismaClient - Prisma client.
 * @param {Function} params.buildAndSign - `({ accountRecord, asset, fee }) => transaction`.
 *   Must be supplied: it is the only thing that can authorize the trustor.
 * @param {Function} params.submit - `(transaction) => Promise<{ hash }>`.
 * @param {string} [params.network] - Defaults to the configured network.
 * @param {bigint} [params.baseReserveStroops]
 * @param {object} [params.feeBumpSponsor] - Accepted and explicitly ignored for
 *   reserve purposes; see the module header.
 * @returns {Promise<object>} outcome describing what happened and why.
 */
const ensureTrustline = async ({
  wallet,
  assetCode,
  horizon,
  prismaClient,
  buildAndSign,
  submit,
  network = config.stellar.network,
  baseReserveStroops = DEFAULT_BASE_RESERVE_STROOPS,
  feeBumpSponsor = null,
}) => {
  // Resolving first means an unsupported code or unconfigured issuer costs no
  // Horizon call and writes no row.
  const resolved = resolveCorridorAsset({ code: assetCode, network });

  if (!wallet?.id || !wallet?.publicKey) {
    throw codedError('A wallet with a publicKey is required.', TRUSTLINE_ERROR_CODES.ACCOUNT_NOT_FUNDED);
  }

  // ── Is it already there? ───────────────────────────────────────────────
  let accountRecord;
  try {
    accountRecord = await horizon.loadAccount(wallet.publicKey);
  } catch (error) {
    throw codedError(
      'Account is not funded yet — fund it before opening a trustline.',
      TRUSTLINE_ERROR_CODES.ACCOUNT_NOT_FUNDED,
      { cause: error.message },
    );
  }

  if (hasTrustline({ accountRecord, code: resolved.code, issuer: resolved.issuer })) {
    // Idempotent no-op. Reconcile the tracking row so a previously pending
    // request does not linger.
    await markRequest({
      prismaClient,
      wallet,
      resolved,
      network,
      data: { status: TRUSTLINE_STATUS.ESTABLISHED, lastError: null },
    });
    return {
      established: true,
      alreadyExisted: true,
      submitted: false,
      assetId: resolved.assetId,
    };
  }

  // ── Can the account afford the subentry? ───────────────────────────────
  let feeStroops = DEFAULT_FEE_STROOPS;
  if (typeof horizon.fetchBaseFee === 'function') {
    try {
      feeStroops = BigInt(await horizon.fetchBaseFee());
    } catch (_error) {
      // Keep the conservative default rather than failing the whole flow.
      feeStroops = DEFAULT_FEE_STROOPS;
    }
  }

  const reserve = trustlineReserveRequirement({
    accountRecord, baseReserveStroops, feeStroops, additionalSubentries: 1,
  });

  if (!reserve.sufficient) {
    // A fee-bump sponsor does NOT change this: it pays fees, not reserves.
    // Only sponsored reserves would, and that is not implemented here.
    await markRequest({
      prismaClient,
      wallet,
      resolved,
      network,
      data: {
        status: TRUSTLINE_STATUS.FAILED,
        lastError: `insufficient_reserve: needs ${reserve.requiredXlm} XLM, holds ${reserve.balanceXlm}`,
      },
    });
    throw codedError(
      `Insufficient XLM reserve for a ${resolved.code} trustline. `
      + `Keep at least ${reserve.requiredXlm} XLM (currently ${reserve.balanceXlm}), then retry.`
      + (feeBumpSponsor
        ? ' A fee-bump sponsor pays the fee but not the base reserve.'
        : ''),
      TRUSTLINE_ERROR_CODES.INSUFFICIENT_RESERVE,
      { required: reserve.requiredXlm, balance: reserve.balanceXlm, shortfall: reserve.shortfall.toString() },
    );
  }

  // ── Authorization: only the trustor can open its own trustline ─────────
  if (typeof buildAndSign !== 'function') {
    throw codedError(
      `No signer available for ${wallet.publicKey}; a ChangeTrust operation must be `
      + 'signed by the trustor and cannot be authorized by a fee-bump sponsor.',
      TRUSTLINE_ERROR_CODES.NO_SIGNER,
    );
  }

  // ── Claim the right to submit, exactly once ────────────────────────────
  const claim = await claimRequest({ prismaClient, wallet, resolved, network });
  if (!claim.claimed) {
    // Another caller (or replica) already owns this ChangeTrust. Converge on
    // its row instead of submitting a second operation.
    return {
      established: claim.row.status === TRUSTLINE_STATUS.ESTABLISHED,
      alreadyExisted: false,
      submitted: false,
      duplicateSuppressed: true,
      status: claim.row.status,
      assetId: resolved.assetId,
    };
  }

  let transaction;
  try {
    transaction = await buildAndSign({
      accountRecord, asset: resolved.asset, fee: feeStroops.toString(),
    });
  } catch (error) {
    await markRequest({
      prismaClient, wallet, resolved, network,
      data: { status: TRUSTLINE_STATUS.FAILED, lastError: `sign_failed: ${error.message}` },
    });
    throw codedError(
      `Could not sign the ChangeTrust operation: ${error.message}`,
      TRUSTLINE_ERROR_CODES.NO_SIGNER,
    );
  }

  // ── Submit ─────────────────────────────────────────────────────────────
  try {
    const response = await submit(transaction);
    await markRequest({
      prismaClient, wallet, resolved, network,
      data: {
        status: TRUSTLINE_STATUS.ESTABLISHED,
        txHash: response?.hash || null,
        lastError: null,
      },
    });
    return {
      established: true,
      alreadyExisted: false,
      submitted: true,
      txHash: response?.hash || null,
      assetId: resolved.assetId,
    };
  } catch (error) {
    const uncertain = isSubmissionUncertain(error);
    const codes = resultCodesOf(error);

    await markRequest({
      prismaClient, wallet, resolved, network,
      data: {
        // Uncertain stays `submitted`: the operation may be in the ledger, and
        // resubmitting could duplicate it. Reconciliation settles it later.
        status: uncertain ? TRUSTLINE_STATUS.SUBMITTED : TRUSTLINE_STATUS.FAILED,
        lastError: codes ? `${codes}` : String(error.message).slice(0, 500),
      },
    });

    if (uncertain) {
      logger.warn(
        `Trustline ${resolved.assetId} for ${wallet.publicKey}: submission outcome unknown; `
        + 'left pending for reconciliation rather than resubmitted.',
      );
      return {
        established: false,
        submitted: true,
        pending: true,
        reason: TRUSTLINE_ERROR_CODES.SUBMISSION_UNCERTAIN,
        assetId: resolved.assetId,
      };
    }

    throw codedError(
      `ChangeTrust submission failed for ${resolved.code}${codes ? ` (${codes})` : ''}.`,
      TRUSTLINE_ERROR_CODES.SUBMISSION_FAILED,
      { resultCodes: codes },
    );
  }
};

/**
 * Atomically claim the right to submit a ChangeTrust for this asset identity.
 *
 * Returns `{ claimed: true }` only for the caller that created the row, or
 * that found an existing row in a resubmittable state. The UNIQUE constraint
 * is the arbiter.
 */
const claimRequest = async ({ prismaClient, wallet, resolved, network }) => {
  if (!prismaClient?.trustlineRequest) {
    // No tracking table available (partial mock, or a deployment without the
    // migration). Proceed, but say so: duplicate suppression is degraded.
    return { claimed: true, row: null, untracked: true };
  }

  try {
    const row = await prismaClient.trustlineRequest.create({
      data: {
        walletId: wallet.id,
        assetCode: resolved.code,
        assetIssuer: resolved.issuer,
        network,
        status: TRUSTLINE_STATUS.PENDING,
        attempts: 1,
      },
    });
    return { claimed: true, row };
  } catch (error) {
    if (error?.code !== PRISMA_UNIQUE_VIOLATION) throw error;

    const existing = await prismaClient.trustlineRequest.findUnique({
      where: {
        walletId_assetCode_assetIssuer: {
          walletId: wallet.id, assetCode: resolved.code, assetIssuer: resolved.issuer,
        },
      },
    });

    // An established or in-flight request is owned by someone else. A failed
    // one may be retried.
    if (existing && existing.status === TRUSTLINE_STATUS.FAILED) {
      const retried = await prismaClient.trustlineRequest.update({
        where: { id: existing.id },
        data: {
          status: TRUSTLINE_STATUS.PENDING,
          attempts: (existing.attempts || 0) + 1,
          lastError: null,
        },
      });
      return { claimed: true, row: retried };
    }

    return { claimed: false, row: existing || { status: TRUSTLINE_STATUS.PENDING } };
  }
};

/** Upsert the tracking row for this asset identity. */
const markRequest = async ({ prismaClient, wallet, resolved, network, data }) => {
  if (!prismaClient?.trustlineRequest) return null;
  const where = {
    walletId_assetCode_assetIssuer: {
      walletId: wallet.id, assetCode: resolved.code, assetIssuer: resolved.issuer,
    },
  };
  try {
    return await prismaClient.trustlineRequest.upsert({
      where,
      create: {
        walletId: wallet.id,
        assetCode: resolved.code,
        assetIssuer: resolved.issuer,
        network,
        attempts: 1,
        ...data,
      },
      update: data,
    });
  } catch (error) {
    logger.warn(`Trustline tracking update failed for ${resolved.assetId}: ${error.message}`);
    return null;
  }
};

/**
 * Pre-transfer hook: make sure the recipient can actually receive the asset.
 *
 * Native XLM needs no trustline, so it short-circuits. Intended to be called
 * from the transfer flow immediately before an issued-asset payment.
 *
 * @param {object} params - As `ensureTrustline`, plus `assetCode`.
 * @returns {Promise<object>} `{ required: boolean, ...ensureTrustline outcome }`
 */
const ensureTrustlineForTransfer = async ({ assetCode, ...rest }) => {
  const code = String(assetCode || '').toUpperCase();
  if (!code || code === 'XLM' || code === 'NATIVE') {
    // XLM is the native asset: no issuer, no trustline, no subentry.
    return { required: false, established: true, alreadyExisted: true, submitted: false };
  }
  const outcome = await ensureTrustline({ assetCode: code, ...rest });
  return { required: true, ...outcome };
};

/**
 * Settle `submitted` (uncertain) requests by re-reading the account.
 *
 * This is how an uncertain submission is resolved without ever submitting a
 * second ChangeTrust: ask the ledger what actually happened.
 *
 * @param {object} params
 * @param {object} params.prismaClient
 * @param {object} params.horizon
 * @param {string} [params.network]
 * @param {number} [params.take]
 * @returns {Promise<{ checked: number, established: number, stillPending: number }>}
 */
const reconcilePendingTrustlines = async ({
  prismaClient,
  horizon,
  network = config.stellar.network,
  take = 50,
}) => {
  if (!prismaClient?.trustlineRequest) return { checked: 0, established: 0, stillPending: 0 };

  const pending = await prismaClient.trustlineRequest.findMany({
    where: { status: TRUSTLINE_STATUS.SUBMITTED, network },
    take,
  });

  let established = 0;
  let stillPending = 0;

  for (const row of pending) {
    try {
      const wallet = await prismaClient.wallet.findUnique({ where: { id: row.walletId } });
      if (!wallet?.publicKey) { stillPending += 1; continue; }

      const accountRecord = await horizon.loadAccount(wallet.publicKey);
      if (hasTrustline({ accountRecord, code: row.assetCode, issuer: row.assetIssuer })) {
        await prismaClient.trustlineRequest.update({
          where: { id: row.id },
          data: { status: TRUSTLINE_STATUS.ESTABLISHED, lastError: null },
        });
        established += 1;
      } else {
        stillPending += 1;
      }
    } catch (error) {
      // One bad row never stalls reconciliation.
      logger.warn(`Trustline reconciliation skipped ${row.id}: ${error.message}`);
      stillPending += 1;
    }
  }

  return { checked: pending.length, established, stillPending };
};

module.exports = {
  SUPPORTED_CORRIDORS,
  TRUSTLINE_STATUS,
  TRUSTLINE_ERROR_CODES,
  DEFAULT_BASE_RESERVE_STROOPS,
  DEFAULT_FEE_STROOPS,
  resolveCorridorAsset,
  corridorAvailability,
  hasTrustline,
  nativeBalanceStroops,
  trustlineReserveRequirement,
  isSubmissionUncertain,
  ensureTrustline,
  ensureTrustlineForTransfer,
  reconcilePendingTrustlines,
};
