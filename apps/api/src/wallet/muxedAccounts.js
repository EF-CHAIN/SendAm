'use strict';

// Stellar muxed account (MED25519) routing for virtual sub-wallets (#958).
//
// ── Why muxed accounts ────────────────────────────────────────────────────
//
// Giving every user their own on-chain Stellar account costs real money: a
// base reserve per account (0.5 XLM) plus another base reserve per trustline,
// and someone has to fund each one before it can receive anything. A muxed
// address (`M...`, strkey type MED25519) sidesteps that entirely. It packs a
// 64-bit sub-account id together with one underlying `G...` account, so a
// single funded account can hand out an unlimited number of distinct
// receiving addresses.
//
// ── The conceptual trap ───────────────────────────────────────────────────
//
// A muxed sub-account is NOT an account. It has:
//
//   * no reserve of its own,
//   * no trustlines of its own,
//   * no balance of its own,
//   * no signers of its own,
//   * no existence on the ledger whatsoever.
//
// Every sub-account shares the underlying account's reserves, trustlines and
// balance. The ledger sees exactly one account. The division between users is
// pure off-chain bookkeeping, and this module plus the `MuxedSubAccount` and
// `DepositCredit` tables are that bookkeeping. Nothing here ever funds a
// sub-account or opens a trustline for one, because there is nothing to fund
// and no trustline to open — see `assignSubAccount`.
//
// ── Horizon's wire format, and the two traps in it ───────────────────────
//
// From stellar/go `protocols/horizon/operations/main.go`:
//
//     To          string `json:"to"`
//     ToMuxed     string `json:"to_muxed,omitempty"`
//     ToMuxedID   uint64 `json:"to_muxed_id,omitempty,string"`
//
// Three consequences drive `describeIncomingPayment` below:
//
//  1. `to` is always the base `G...` account, never the `M...` address. So
//     the deposit poller's existing `r.to === publicKey` filter already
//     matches muxed payments; routing is additive, not a replacement.
//
//  2. The `,string` struct tag means `to_muxed_id` arrives as a JSON *string*
//     — deliberately, to survive JSON's float-only numbers. uint64 max is
//     18446744073709551615, which is far beyond Number.MAX_SAFE_INTEGER
//     (9007199254740991). Parsing it with Number() or parseInt() silently
//     corrupts the id and misroutes the deposit, so every id in this module
//     is a BigInt internally and a decimal string at the boundaries.
//
//  3. `omitempty` on a uint64 means a muxed id of **0 is omitted entirely**.
//     Sub-account 0 is perfectly legitimate. So "was this payment muxed?" is
//     answered by `to_muxed` being present, NOT by `to_muxed_id`. When
//     `to_muxed` is present and `to_muxed_id` is absent, the id is 0 — not
//     "no sub-account". Getting this backwards credits a muxed deposit to the
//     base wallet's owner.

const StellarSdk = require('@stellar/stellar-sdk');

const assetIdentity = require('./assetIdentity');
const stellarAdapter = require('./stellar.adapter');
const logger = require('../utils/logger');
const ledgerService = require('../payment/ledger.service');

/**
 * Largest valid muxed sub-account id: 2^64 - 1.
 *
 * Held as a BigInt because this value is not representable as a JS Number —
 * `Number(18446744073709551615)` rounds to 18446744073709551616.
 */
const MAX_MUXED_ID = 18446744073709551615n;

/** Prisma's unique-constraint violation code. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

/**
 * Reasons `creditDeposit` can decline to credit a payment. Stable strings:
 * they are returned to callers, logged, and asserted on in tests.
 */
const DECLINE_REASONS = Object.freeze({
  NOT_A_PAYMENT: 'not_a_payment',
  FAILED_TRANSACTION: 'failed_transaction',
  WRONG_DESTINATION: 'wrong_destination',
  NETWORK_MISMATCH: 'network_mismatch',
  UNKNOWN_SUB_ACCOUNT: 'unknown_sub_account',
  UNTRUSTED_ASSET: 'untrusted_asset',
  DUPLICATE: 'duplicate',
});

/**
 * Build an error carrying a stable machine-readable `code`, following the
 * idiom used across the wallet modules.
 *
 * @param {string} message - Human-readable message. Never include key material.
 * @param {string} code - Stable error code for callers to switch on.
 * @returns {Error}
 */
const codedError = (message, code) => Object.assign(new Error(message), { code });

/**
 * Normalise a muxed sub-account id to its canonical decimal string form.
 *
 * Accepts a BigInt, a decimal string, or a Number that is a safe integer.
 * Rejects anything that cannot represent a uint64 exactly — in particular a
 * Number beyond Number.MAX_SAFE_INTEGER, which is accepted nowhere in this
 * module because the value has already lost precision by the time we see it.
 *
 * @param {bigint|string|number} value - The sub-account id.
 * @returns {string} Canonical decimal string (no leading zeros, no sign).
 * @throws {Error} code `invalid_muxed_id` if the value is not a uint64.
 */
const normalizeMuxedId = (value) => {
  if (value === null || value === undefined) {
    throw codedError('Muxed sub-account id is required.', 'invalid_muxed_id');
  }

  let big;

  if (typeof value === 'bigint') {
    big = value;
  } else if (typeof value === 'number') {
    // A non-safe integer has already been rounded by the JSON parser or by
    // arithmetic upstream. Refusing it is the only honest option: we cannot
    // recover the digits that were lost.
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw codedError(
        'Muxed sub-account id must be an exact integer; this Number has already lost '
        + 'precision. Pass the id as a decimal string or a BigInt.',
        'invalid_muxed_id',
      );
    }
    big = BigInt(value);
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    // Reject "+1", "1.0", "0x10", "1e3", "" and whitespace-only up front:
    // BigInt() accepts some of these shapes and we want one canonical form.
    if (!/^\d+$/.test(trimmed)) {
      throw codedError(
        `Muxed sub-account id must be an unsigned decimal integer string (got ${JSON.stringify(value)}).`,
        'invalid_muxed_id',
      );
    }
    big = BigInt(trimmed);
  } else {
    throw codedError(
      `Muxed sub-account id must be a string, number or bigint (got ${typeof value}).`,
      'invalid_muxed_id',
    );
  }

  if (big < 0n) {
    throw codedError('Muxed sub-account id cannot be negative.', 'invalid_muxed_id');
  }
  if (big > MAX_MUXED_ID) {
    throw codedError(
      `Muxed sub-account id exceeds the 64-bit maximum (${MAX_MUXED_ID}).`,
      'invalid_muxed_id',
    );
  }

  return big.toString();
};

/**
 * Encode a base account plus a 64-bit sub-account id as an `M...` address.
 *
 * @param {object} params
 * @param {string} params.baseAccount - The underlying `G...` account.
 * @param {bigint|string|number} params.muxedId - Sub-account id.
 * @returns {string} MED25519 strkey address.
 * @throws {Error} code `invalid_base_account` or `invalid_muxed_id`.
 */
const encodeMuxedAddress = ({ baseAccount, muxedId }) => {
  if (typeof baseAccount !== 'string' || !StellarSdk.StrKey.isValidEd25519PublicKey(baseAccount)) {
    // Explicitly catches the nesting mistake: an `M...` address is not a valid
    // ed25519 public key, and muxed addresses do not nest — the inner account
    // of a muxed address is always a plain `G...`.
    throw codedError(
      'Muxed addresses must be built on a plain ed25519 (G...) account; '
      + 'muxed addresses cannot be nested.',
      'invalid_base_account',
    );
  }

  const id = normalizeMuxedId(muxedId);

  // MuxedAccount wants an Account, but only for its accountId — the sequence
  // number is irrelevant to strkey encoding, so '0' is fine here.
  const muxed = new StellarSdk.MuxedAccount(new StellarSdk.Account(baseAccount, '0'), id);
  return muxed.accountId();
};

/**
 * Decode an `M...` address into its base account and sub-account id.
 *
 * @param {string} address - MED25519 strkey address.
 * @returns {{ baseAccount: string, muxedId: string }} `muxedId` is a decimal string.
 * @throws {Error} code `invalid_muxed_address`.
 */
const decodeMuxedAddress = (address) => {
  if (typeof address !== 'string' || !stellarAdapter.isMuxedAddress(address)) {
    throw codedError(
      'Not a valid MED25519 muxed address (M...).',
      'invalid_muxed_address',
    );
  }

  let muxed;
  try {
    muxed = StellarSdk.MuxedAccount.fromAddress(address, '0');
  } catch (error) {
    // A strkey that passes the length/prefix check can still fail the
    // checksum or XDR decode.
    throw codedError(
      `Muxed address could not be decoded: ${error.message}`,
      'invalid_muxed_address',
    );
  }

  return {
    baseAccount: muxed.baseAccount().accountId(),
    // MuxedAccount.id() is already a decimal string; normalise anyway so the
    // 64-bit guarantee is enforced on every path out of this module.
    muxedId: normalizeMuxedId(muxed.id()),
  };
};

/**
 * Assign (or look up) a virtual sub-wallet for a user on a wallet's account.
 *
 * Deliberately does NOT fund anything and does NOT open a trustline: a muxed
 * sub-account has no reserve and no trustline of its own, it shares the
 * underlying account's. Any code that tries to fund a sub-account has
 * misunderstood muxed accounts.
 *
 * Idempotent on `(baseAccount, muxedId)`: a concurrent caller that loses the
 * insert race gets the existing row back rather than an error. Letting the
 * unique constraint arbitrate is deliberate — a read-then-write "does it
 * exist?" check races between replicas.
 *
 * @param {object} params
 * @param {string} params.userId - Owner of the sub-wallet.
 * @param {object} params.wallet - Wallet row; needs `id` and `publicKey`.
 * @param {bigint|string|number} params.muxedId - Sub-account id to assign.
 * @param {object} params.prismaClient - Prisma client (injected for tests).
 * @param {string} params.network - Active Stellar network id.
 * @returns {Promise<object>} The mapping row plus its derived `address`.
 */
const assignSubAccount = async ({ userId, wallet, muxedId, prismaClient, network }) => {
  if (!userId) throw codedError('userId is required to assign a sub-wallet.', 'invalid_user');
  if (!wallet?.id || !wallet?.publicKey) {
    throw codedError('A funded wallet with a publicKey is required.', 'invalid_wallet');
  }

  const baseAccount = wallet.publicKey;
  const id = normalizeMuxedId(muxedId);
  // Validates the base account and proves the pair is encodable before we
  // write a row that claims it is.
  const address = encodeMuxedAddress({ baseAccount, muxedId: id });

  const data = {
    userId,
    walletId: wallet.id,
    muxedId: id,
    baseAccount,
    network,
  };

  try {
    const row = await prismaClient.muxedSubAccount.create({ data });
    return { ...row, address };
  } catch (error) {
    if (error?.code === PRISMA_UNIQUE_VIOLATION) {
      const existing = await prismaClient.muxedSubAccount.findUnique({
        where: { baseAccount_muxedId: { baseAccount, muxedId: id } },
      });
      if (existing) return { ...existing, address };
    }
    throw error;
  }
};

/**
 * Resolve a sub-account mapping, or `null` when the id is not one we issued.
 *
 * Returning `null` rather than throwing is intentional: an unknown id is a
 * normal operational event (someone paid an address we never handed out, or a
 * mapping was deleted), and the caller must handle it by *not* crediting
 * anyone — never by falling back to the base account's owner.
 *
 * @param {object} params
 * @param {string} params.baseAccount - Underlying `G...` account.
 * @param {bigint|string|number} params.muxedId - Sub-account id.
 * @param {object} params.prismaClient - Prisma client.
 * @returns {Promise<object|null>}
 */
const resolveSubAccount = async ({ baseAccount, muxedId, prismaClient }) => {
  let id;
  try {
    id = normalizeMuxedId(muxedId);
  } catch (_error) {
    // An unparseable id cannot match a stored mapping by definition.
    return null;
  }

  if (!prismaClient?.muxedSubAccount) return null;

  return prismaClient.muxedSubAccount.findUnique({
    where: { baseAccount_muxedId: { baseAccount, muxedId: id } },
  });
};

/**
 * Describe a Horizon payment record's destination in muxed terms.
 *
 * Pure function; no I/O. This is where the three Horizon wire-format
 * consequences documented at the top of this file are implemented.
 *
 * @param {object} record - Horizon payment operation record.
 * @returns {{ isMuxed: boolean, baseAccount: string|null, muxedId: string|null,
 *            paymentId: string|null, muxedAddress: string|null }}
 */
const describeIncomingPayment = (record) => {
  const baseAccount = typeof record?.to === 'string' ? record.to : null;
  const muxedAddress = typeof record?.to_muxed === 'string' && record.to_muxed
    ? record.to_muxed
    : null;

  // Horizon's canonical paging key, with the same fallbacks the deposit
  // poller already uses so both agree on one idempotency key per payment.
  const rawId = record?.paging_token || record?.id || record?.transaction_hash;
  const paymentId = rawId == null ? null : String(rawId);

  // Trap 3: presence of `to_muxed` — not `to_muxed_id` — is what makes this a
  // muxed payment. `to_muxed_id` is omitted when the id is 0.
  if (!muxedAddress) {
    return { isMuxed: false, baseAccount, muxedId: null, paymentId, muxedAddress: null };
  }

  let muxedId;
  if (record.to_muxed_id === undefined || record.to_muxed_id === null || record.to_muxed_id === '') {
    // Omitted by `omitempty` ⇒ the id is zero, which is a real sub-account.
    muxedId = '0';
  } else {
    // Trap 2: normally a decimal string. A JSON number is accepted only when
    // it is still exact; otherwise normalizeMuxedId throws and we surface the
    // record as undeliverable rather than misrouting it.
    muxedId = normalizeMuxedId(record.to_muxed_id);
  }

  return { isMuxed: true, baseAccount, muxedId, paymentId, muxedAddress };
};

/**
 * Credit an inbound Stellar payment to the user it actually belongs to.
 *
 * Validation order matters: cheap structural checks first, then destination
 * and network, then asset trust, then ownership, and only then the write.
 *
 * Exactly-once is enforced by the UNIQUE `DepositCredit.stellarPaymentId`
 * inside the same transaction as the ledger posting, so a replayed Horizon
 * cursor, a mid-write crash or a second replica cannot double-credit. The
 * unique constraint is the arbiter rather than a preceding existence check,
 * because a read-then-write check has a window between the read and the write
 * in which another replica can insert the same payment.
 *
 * @param {object} params
 * @param {object} params.record - Horizon payment record.
 * @param {object} params.wallet - Wallet row; needs `id`, `userId`, `publicKey`.
 * @param {object} params.prismaClient - Prisma client.
 * @param {string} params.network - Active Stellar network id.
 * @param {object} [params.ledger] - Ledger service (injected for tests).
 * @returns {Promise<object>} `{ credited, reason?, duplicate?, userId?, muxedId?, ... }`
 */
const creditDeposit = async ({
  record,
  wallet,
  prismaClient,
  network,
  ledger = ledgerService,
}) => {
  // ── Structural validation ───────────────────────────────────────────────
  if (record?.type !== 'payment') {
    return { credited: false, reason: DECLINE_REASONS.NOT_A_PAYMENT };
  }

  // Only a successful payment moves value. Horizon omits the field on some
  // endpoints, so treat an explicit `false` as failure and absence as success,
  // matching how the rest of the codebase reads this flag.
  if (record.transaction_successful === false) {
    return { credited: false, reason: DECLINE_REASONS.FAILED_TRANSACTION };
  }

  let destination;
  try {
    destination = describeIncomingPayment(record);
  } catch (error) {
    // An id we cannot represent exactly: refuse rather than guess.
    return { credited: false, reason: DECLINE_REASONS.UNKNOWN_SUB_ACCOUNT, detail: error.code };
  }

  // ── Destination must be this wallet's own account ───────────────────────
  if (!destination.baseAccount || destination.baseAccount !== wallet?.publicKey) {
    return { credited: false, reason: DECLINE_REASONS.WRONG_DESTINATION };
  }

  // ── Network must match the ledger this process is reading ───────────────
  // Polling testnet material against mainnet Horizon (or the reverse) can
  // otherwise credit a deposit that never happened on the user's network.
  if (wallet.network && wallet.network !== network) {
    return { credited: false, reason: DECLINE_REASONS.NETWORK_MISMATCH };
  }

  // ── Asset identity: never trust a code alone ────────────────────────────
  const identity = assetIdentity.describeAsset({
    network,
    assetType: record.asset_type,
    code: record.asset_code,
    issuer: record.asset_issuer,
  });

  if (!identity.trusted) {
    // Anyone can issue a token called "USDC". Crediting a user's balance for
    // an unrecognised issuer would turn a worthless token into spendable
    // value, so this is a hard refusal, not a warning.
    logger.warn(
      `Muxed routing: refusing to credit untrusted asset ${identity.assetId} `
      + `on payment ${destination.paymentId}.`,
    );
    return { credited: false, reason: DECLINE_REASONS.UNTRUSTED_ASSET, assetId: identity.assetId };
  }

  // ── Ownership: who does this money belong to? ───────────────────────────
  let ownerUserId = wallet.userId;
  let subAccount = null;

  if (destination.isMuxed) {
    subAccount = await resolveSubAccount({
      baseAccount: destination.baseAccount,
      muxedId: destination.muxedId,
      prismaClient,
    });

    if (!subAccount) {
      // An address we never issued. The money is on the shared account but we
      // do not know whose it is. Crediting the base wallet's owner would hand
      // one user another's funds, so this becomes an unclaimed deposit for
      // operators to reconcile.
      logger.warn(
        `Muxed routing: payment ${destination.paymentId} arrived for unknown sub-account `
        + `${destination.muxedId} on ${destination.baseAccount}; left unclaimed for reconciliation.`,
      );
      return {
        credited: false,
        reason: DECLINE_REASONS.UNKNOWN_SUB_ACCOUNT,
        muxedId: destination.muxedId,
      };
    }

    ownerUserId = subAccount.userId;
  }

  // ── Write: credit + ledger posting, atomically and exactly once ─────────
  const creditData = {
    stellarPaymentId: destination.paymentId,
    userId: ownerUserId,
    walletId: wallet.id,
    muxedId: destination.isMuxed ? destination.muxedId : null,
    asset: identity.code,
    assetIssuer: identity.issuer,
    amount: String(record.amount),
    network,
  };

  const runCredit = async (tx) => {
    const credit = await tx.depositCredit.create({ data: creditData });

    // Double-entry posting, when the ledger tables are available. External
    // value entering the system: the user's balance rises and the settled
    // Stellar position rises with it.
    let journalEntryId = null;
    if (tx.journalEntry && tx.ledgerAccount && tx.ledgerPosting) {
      const entry = await ledger.createJournalEntry({
        tx,
        eventType: 'deposit.credited',
        externalRef: destination.paymentId,
        metadata: {
          muxedId: destination.isMuxed ? destination.muxedId : null,
          assetId: identity.assetId,
          network,
        },
        postings: [
          { type: 'stellar_settled', asset: identity.code, amount: `-${record.amount}` },
          { type: 'customer_money', userId: ownerUserId, asset: identity.code, amount: String(record.amount) },
        ],
      });
      journalEntryId = entry?.id || null;
      if (journalEntryId) {
        await tx.depositCredit.update({
          where: { id: credit.id },
          data: { journalEntryId },
        });
      }
    }

    return { credit, journalEntryId };
  };

  try {
    const { credit, journalEntryId } = typeof prismaClient.$transaction === 'function'
      ? await prismaClient.$transaction(runCredit)
      : await runCredit(prismaClient);

    return {
      credited: true,
      creditId: credit.id,
      userId: ownerUserId,
      muxedId: destination.isMuxed ? destination.muxedId : null,
      asset: identity.code,
      amount: String(record.amount),
      journalEntryId,
    };
  } catch (error) {
    if (error?.code === PRISMA_UNIQUE_VIOLATION) {
      // Already credited. The ledger entry was written in the same
      // transaction as the original row, so there is nothing to reconcile and
      // nothing to post again.
      return {
        credited: false,
        duplicate: true,
        reason: DECLINE_REASONS.DUPLICATE,
        userId: ownerUserId,
      };
    }
    throw error;
  }
};

/**
 * Look up the phone number to notify for a resolved deposit.
 *
 * For a muxed deposit the money belongs to the sub-account's owner, who is
 * generally NOT the base wallet's owner — so notifying `wallet.phoneNumber`
 * would tell the wrong person they received funds. Falls back to the wallet's
 * own number when there is no sub-account or no user row to read.
 *
 * @param {object} params
 * @param {string|null} params.userId - Resolved owner.
 * @param {object} params.wallet - Wallet row.
 * @param {object} params.prismaClient - Prisma client.
 * @returns {Promise<string|null>}
 */
const resolveNotificationTarget = async ({ userId, wallet, prismaClient }) => {
  if (!userId || userId === wallet?.userId) return wallet?.phoneNumber || null;
  if (!prismaClient?.user?.findUnique) return wallet?.phoneNumber || null;

  try {
    const user = await prismaClient.user.findUnique({
      where: { id: userId },
      select: { phoneNumber: true },
    });
    return user?.phoneNumber || wallet?.phoneNumber || null;
  } catch (_error) {
    return wallet?.phoneNumber || null;
  }
};

module.exports = {
  MAX_MUXED_ID,
  DECLINE_REASONS,
  normalizeMuxedId,
  encodeMuxedAddress,
  decodeMuxedAddress,
  assignSubAccount,
  resolveSubAccount,
  describeIncomingPayment,
  creditDeposit,
  resolveNotificationTarget,
};
