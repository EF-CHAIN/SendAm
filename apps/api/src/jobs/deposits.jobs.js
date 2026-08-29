// Deposit poller — #31 + #158
//
// Background loop that watches every Stellar wallet for inbound payments and
// notifies the owner over WhatsApp/sim.  Runs as a plain in-process
// setInterval (no Redis/BullMQ dependency at this scale).
//
// Design rules (from the issue spec, updated for #158):
//
//  1. New inbound payment → exactly one notification, cursor advanced.
//  2. Re-running with the same cursor → zero notifications.
//  3. Outbound payments and old history never notify.
//  4. One failing wallet never stalls the loop.
//  5. Atomic outbox: the cursor is advanced AND a durable outbox intent
//     (DepositOutboxRecord) is written in a single DB transaction BEFORE
//     attempting delivery.  A crash between persistence and delivery leaves a
//     pending outbox row that the retry worker will deliver exactly once via
//     the idempotent stellarPaymentId key — no lost or duplicate alerts.
//  6. First poll of a null-cursor wallet: initialise cursor to the latest
//     Horizon paging token without notifying.  This prevents replaying
//     the entire payment history when a wallet is first seen by the poller.
//  7. Multi-page Horizon results are drained within a single poll cycle so
//     no records are skipped when more than one page (200) of payments is
//     pending for a wallet.
//

'use strict';

const { server: horizonServer } = require('../config/stellar');
const prisma = require('../common/prisma');
const { sendTextMessage } = require('../services/whatsapp.service');
const { getExchangeRate } = require('../pricing/pricing.service');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Notification text — "You received 20 USDC (~₦31,000)"
// The fiat hint is best-effort: if the exchange-rate call fails we omit it
// rather than blocking or crashing.
// ---------------------------------------------------------------------------

/**
 * Format a deposit notification message.
 *
 * @param {string|number} amount  - e.g. "20.0000000"
 * @param {string}        asset   - e.g. "USDC" | "XLM" | "native"
 * @param {number|null}   fiatRate - NGN per 1 unit of asset (may be null)
 * @returns {string}
 */
const formatDepositMessage = (amount, asset, fiatRate) => {
  const displayAsset = asset === 'native' ? 'XLM' : asset;
  const numericAmount = Number(amount);

  // Format the amount: strip trailing fractional zeros (e.g. "20.0000000" → "20"),
  // but only after the decimal point — never strip digits before it.
  let displayAmount;
  if (Number.isFinite(numericAmount)) {
    // toFixed(7) gives us a consistent representation, then strip trailing
    // decimal zeros and the decimal point if it becomes redundant.
    const fixed = numericAmount.toFixed(7);
    // Strip trailing zeros after decimal, then the decimal itself if empty.
    const stripped = fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    displayAmount = Number(stripped).toLocaleString('en-US', { maximumFractionDigits: 7 });
  } else {
    displayAmount = String(amount);
  }

  let hint = '';
  if (fiatRate != null && Number.isFinite(fiatRate) && Number.isFinite(numericAmount)) {
    const fiatValue = numericAmount * fiatRate;
    const rounded = Math.round(fiatValue);
    hint = ` (~₦${rounded.toLocaleString('en-US')})`;
  }

  return `You received ${displayAmount} ${displayAsset}${hint}.`;
};

// ---------------------------------------------------------------------------
// Horizon helpers
// ---------------------------------------------------------------------------

/**
 * Fetch one page of payment operations for a public key, starting at cursor.
 * Returns { records, nextCursor }.
 *
 * We ask for `order=asc` with `cursor` so new payments arrive in
 * chronological order and we can advance the cursor page-by-page.
 *
 * @param {object} horizon - Horizon.Server instance (injected for tests)
 * @param {string} publicKey
 * @param {string|null} cursor - paging token; null means "from the beginning"
 * @returns {Promise<{ records: object[], nextCursor: string|null }>}
 */
const fetchPaymentsPage = async (horizon, publicKey, cursor) => {
  let builder = horizon
    .payments()
    .forAccount(publicKey)
    .order('asc')
    .limit(200);

  if (cursor != null) {
    builder = builder.cursor(cursor);
  }

  const page = await builder.call();
  const records = page.records || [];

  // The next cursor for this account is the paging_token of the last record
  // we received.  If the page was empty the cursor stays where it is.
  const lastRecord = records[records.length - 1];
  const nextCursor = lastRecord ? lastRecord.paging_token : cursor;

  return { records, nextCursor };
};

/**
 * Fetch the latest paging token for an account without replaying history.
 * Uses order=desc limit=1 when available, falls back to asc paging.
 */
const fetchLatestCursor = async (horizon, publicKey) => {
  try {
    const builder = horizon.payments().forAccount(publicKey).order('desc').limit(1);
    const page = await builder.call();
    const rec = page.records && page.records[0];
    if (rec && rec.paging_token) return rec.paging_token;
  } catch (_) {
    // fall through to asc fallback
  }
  // Fallback: fetch one asc page and use its last token (may be oldest if history >200
  // but still prevents empty-cursor crash; caller will advance via polling)
  try {
    const { nextCursor } = await fetchPaymentsPage(horizon, publicKey, null);
    return nextCursor;
  } catch (_) {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Per-wallet poll helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Per-wallet poll
// ---------------------------------------------------------------------------

/**
 * Poll one wallet for new inbound payments.
 *
 * Drains all Horizon pages (multi-page) within this single poll cycle and
 * persists each inbound payment atomically (wallet cursor + outbox upsert)
 * before attempting delivery. Duplicate Horizon records (same
 * stellarPaymentId) are idempotent across restarts and replicas via the
 * unique outbox key.
 *
 * @param {object} wallet   - Prisma Wallet row (needs id, publicKey, phoneNumber, paymentCursor)
 * @param {object} deps     - { horizon, prismaClient, notify, fetchRate }
 */
const pollWallet = async (wallet, deps) => {
  const { horizon, prismaClient, notify, fetchRate } = deps;
  const { id, userId, publicKey, phoneNumber, paymentCursor } = wallet;

  const isFirstPoll = paymentCursor == null;

  // Rule 6: first poll — initialise cursor to latest without notifying.
  if (isFirstPoll) {
    const latest = await fetchLatestCursor(horizon, publicKey);
    if (latest != null) {
      await prismaClient.wallet.update({
        where: { id },
        data: { paymentCursor: latest },
      });
    }
    return;
  }

  // Fetch fiat rate once per poll cycle (best-effort; null is fine).
  let fiatRate = null;
  try {
    fiatRate = await fetchRate();
  } catch (rateErr) {
    logger.warn(`Deposit poller: rate fetch failed for ${publicKey}: ${rateErr.message}`);
  }

  let cursor = paymentCursor;

  // Drain pages until Horizon returns <200 records or empty.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { records, nextCursor } = await fetchPaymentsPage(horizon, publicKey, cursor);

    if (!records || records.length === 0) {
      if (nextCursor !== cursor && nextCursor != null) {
        await prismaClient.wallet.update({
          where: { id },
          data: { paymentCursor: nextCursor },
        });
      }
      break;
    }

    // Filter to inbound payment_type records only (exclude create_account, etc.)
    // and exclude outbound (where the source account is this wallet).
    const inbound = records.filter(
      (r) => r.type === 'payment' && r.to === publicKey,
    );

    if (inbound.length === 0) {
      // No new inbound payments on this page; advance cursor if records moved it.
      if (nextCursor !== cursor) {
        await prismaClient.wallet.update({
          where: { id },
          data: { paymentCursor: nextCursor },
        });
        cursor = nextCursor;
        if (records.length < 200) break;
        // Continue to drain next page
        continue;
      }
      break;
    }

    for (const record of inbound) {
      const amount = record.amount;
      const asset =
        record.asset_type === 'native' ? 'native' : (record.asset_code || record.asset_type);

      const newCursor = record.paging_token;
      // Key by stable Stellar identity for idempotency across restarts/replicas.
      // Prefer paging_token (Horizon's canonical paging key) then id.
      const stellarPaymentId = String(record.paging_token || record.id || record.transaction_hash);
      const message = formatDepositMessage(amount, asset, fiatRate);

      let shouldNotify = true;

      // Atomically write cursor AND outbox intent BEFORE sending.
      if (prismaClient.depositOutboxRecord) {
        await prismaClient.$transaction(async (tx) => {
          await tx.wallet.update({
            where: { id },
            data: { paymentCursor: newCursor },
          });
          await tx.depositOutboxRecord.upsert({
            where: { stellarPaymentId },
            create: {
              stellarPaymentId,
              walletId: id,
              userId: userId || null,
              phoneNumber,
              amount: String(amount),
              asset,
              fiatRate: fiatRate != null ? Number(fiatRate) : null,
              message,
              status: 'pending',
            },
            update: {},
          });
        });

        // Idempotency: if record already existed as delivered, skip duplicate notify.
        try {
          const existing = await prismaClient.depositOutboxRecord.findUnique({
            where: { stellarPaymentId },
          });
          if (existing && existing.status === 'delivered') {
            shouldNotify = false;
          }
        } catch (_) {
          // if lookup fails, still try notify; worst case duplicate is constrained by status check in worker
        }
      } else {
        await prismaClient.wallet.update({
          where: { id },
          data: { paymentCursor: newCursor },
        });
      }

      if (notify && shouldNotify) {
        try {
          const res = await notify(phoneNumber, message, {
            notification: {
              userId: userId || null,
              type: 'deposit_received',
              referenceType: 'wallet',
              referenceId: id,
            },
          });

          if (prismaClient.depositOutboxRecord) {
            const providerMsgId = res && typeof res === 'object' ? (res.messageId || res.id || null) : null;
            await prismaClient.depositOutboxRecord.updateMany({
              where: { stellarPaymentId },
              data: {
                status: 'delivered',
                deliveredAt: new Date(),
                providerMessageId: providerMsgId,
              },
            });
          }
        } catch (err) {
          logger.warn(`Outbox alert delivery deferred for payment ${stellarPaymentId}: ${err.message}`);
          if (prismaClient.depositOutboxRecord) {
            await prismaClient.depositOutboxRecord.updateMany({
              where: { stellarPaymentId, status: 'pending' },
              data: {
                attempts: { increment: 1 },
                lastError: err.message,
              },
            });
          }
        }
      }
    }

    // Advance cursor to nextCursor if it is beyond last inbound's paging_token
    // (e.g. trailing outbound records after last inbound on this page).
    if (nextCursor !== cursor) {
      const currentCursor = (await prismaClient.wallet.findUnique({ where: { id }, select: { paymentCursor: true } }))?.paymentCursor;
      if (currentCursor !== nextCursor) {
        await prismaClient.wallet.update({
          where: { id },
          data: { paymentCursor: nextCursor },
        });
      }
      cursor = nextCursor;
    }

    if (records.length < 200) break;
    // otherwise continue draining next page
  }
};

/**
 * Process pending deposit outbox records with idempotent retries and dead-letter queue bounds.
 */
const processDepositOutbox = async ({ prismaClient = prisma, notify = sendTextMessage, maxAttempts = 5 } = {}) => {
  if (!prismaClient?.depositOutboxRecord) return { processed: 0, delivered: 0, failed: 0, deadLetters: 0 };
  const pendingRecords = await prismaClient.depositOutboxRecord.findMany({
    where: {
      status: 'pending',
      attempts: { lt: maxAttempts },
    },
    take: 50,
  });

  let delivered = 0;
  let failed = 0;
  let deadLetters = 0;

  for (const record of pendingRecords) {
    const nextAttempts = record.attempts + 1;
    try {
      const res = await notify(record.phoneNumber, record.message, {
        notification: {
          userId: record.userId || null,
          type: 'deposit_received',
          referenceType: 'wallet',
          referenceId: record.walletId,
        },
      });
      const providerMsgId = res && typeof res === 'object' ? (res.messageId || res.id || null) : null;
      await prismaClient.depositOutboxRecord.update({
        where: { id: record.id },
        data: {
          status: 'delivered',
          deliveredAt: new Date(),
          providerMessageId: providerMsgId,
          attempts: nextAttempts,
        },
      });
      delivered += 1;
    } catch (err) {
      failed += 1;
      const isDead = nextAttempts >= maxAttempts;
      if (isDead) deadLetters += 1;
      await prismaClient.depositOutboxRecord.update({
        where: { id: record.id },
        data: {
          attempts: nextAttempts,
          lastError: err.message,
          status: isDead ? 'dead_letter' : 'pending',
        },
      });
    }
  }

  return { processed: pendingRecords.length, delivered, failed, deadLetters };
};

/**
 * Replay a failed or dead-letter outbox record by setting its status back to pending.
 */
const replayFailedDepositOutboxRecord = async ({ outboxId, prismaClient = prisma }) => {
  return prismaClient.depositOutboxRecord.update({
    where: { id: outboxId },
    data: { status: 'pending', attempts: 0, lastError: null },
  });
};

/**
 * Replay all dead-letter outbox records.
 */
const replayAllDeadLetters = async ({ prismaClient = prisma }) => {
  return prismaClient.depositOutboxRecord.updateMany({
    where: { status: 'dead_letter' },
    data: { status: 'pending', attempts: 0, lastError: null },
  });
};

/**
 * List deposit outbox records for operator inspection / replay UI.
 * Supports filtering by status and wallet. Returns newest first.
 */
const listDepositOutboxRecords = async ({ prismaClient = prisma, status = null, walletId = null, take = 50, skip = 0 } = {}) => {
  if (!prismaClient?.depositOutboxRecord) return [];
  const where = {};
  if (status) where.status = status;
  if (walletId) where.walletId = walletId;
  return prismaClient.depositOutboxRecord.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take,
    skip,
  });
};

/**
 * List undelivered (pending + failed + dead_letter) outbox records.
 * Convenience for operator dashboards and reconciliation scripts.
 */
const listUndeliveredDepositOutboxRecords = async ({ prismaClient = prisma, walletId = null, take = 50, skip = 0 } = {}) => {
  if (!prismaClient?.depositOutboxRecord) return [];
  const where = {
    status: { in: ['pending', 'failed', 'dead_letter'] },
  };
  if (walletId) where.walletId = walletId;
  return prismaClient.depositOutboxRecord.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take,
    skip,
  });
};

/**
 * Reconcile stuck pending records (older than threshold) for operators.
 * Returns the list of stuck records without mutating; callers can then call
 * replay helpers. This is intentionally read-only to avoid accidental bulk sends.
 */
const findStuckDepositOutboxRecords = async ({ prismaClient = prisma, olderThanMs = 30 * 60 * 1000, take = 50 } = {}) => {
  if (!prismaClient?.depositOutboxRecord) return [];
  const cutoff = new Date(Date.now() - olderThanMs);
  return prismaClient.depositOutboxRecord.findMany({
    where: {
      status: 'pending',
      updatedAt: { lt: cutoff },
    },
    orderBy: { updatedAt: 'asc' },
    take,
  });
};

/**
 * Retention cleanup rule: delete delivered outbox records older than N days.
 */
const cleanupDeliveredOutboxRecords = async ({ olderThanDays = 30, prismaClient = prisma } = {}) => {
  if (!prismaClient?.depositOutboxRecord) return { count: 0 };
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  return prismaClient.depositOutboxRecord.deleteMany({
    where: {
      status: 'delivered',
      deliveredAt: { lt: cutoff },
    },
  });
};

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

/**
 * Run one full sweep across all Stellar wallets.
 * Errors from individual wallets are logged and skipped — never allowed to
 * throw and stall the loop (rule 4).
 *
 * @param {object} deps - { horizon, prismaClient, notify, fetchRate }
 */
const runDepositSweep = async (deps) => {
  const { prismaClient } = deps;

  let wallets;
  try {
    wallets = await prismaClient.wallet.findMany({
      where: { chain: 'stellar', publicKey: { not: null } },
      select: { id: true, userId: true, publicKey: true, phoneNumber: true, paymentCursor: true },
    });
  } catch (err) {
    logger.error(`Deposit poller: failed to load wallets: ${err.message}`);
    return;
  }

  // Process wallets sequentially to stay within Horizon rate limits.
  // Parallelising across hundreds of wallets would exhaust the per-IP quota.
  for (const wallet of wallets) {
    try {
      await pollWallet(wallet, deps);
    } catch (err) {
      // Rule 4: log and move on — never let one wallet stall the loop.
      logger.error(
        `Deposit poller: error polling wallet ${wallet.publicKey}: ${err.message}`,
      );
    }
  }

  // Also process pending outbox records
  try {
    await processDepositOutbox(deps);
  } catch (err) {
    logger.error(`Deposit poller: outbox worker error: ${err.message}`);
  }
};

// ---------------------------------------------------------------------------
// Public: start / stop
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 30_000; // 30 s

/**
 * Start the deposit poller.  Returns a stop function.
 *
 * @param {object} [options]
 * @param {number}   [options.intervalMs]   - Poll interval in ms (default 30 s)
 * @param {object}   [options.horizon]      - Horizon.Server instance (default: config)
 * @param {object}   [options.prismaClient] - Prisma client (default: shared singleton)
 * @param {Function} [options.notify]       - (phoneNumber, text) → Promise (default: whatsapp.service)
 * @param {Function} [options.fetchRate]    - () → Promise<number|null> (default: getExchangeRate NGN/USDC)
 * @returns {{ stop: Function }}
 */
const startDepositPoller = ({
  intervalMs = DEFAULT_INTERVAL_MS,
  horizon = horizonServer,
  prismaClient = prisma,
  notify = sendTextMessage,
  fetchRate = () => getExchangeRate({ sourceCurrency: 'USDC', targetCurrency: 'NGN' }),
} = {}) => {
  const deps = { horizon, prismaClient, notify, fetchRate };

  logger.info(`Deposit poller started (interval: ${intervalMs}ms)`);

  // Run immediately on start, then on each interval tick.
  runDepositSweep(deps).catch((err) => {
    logger.error(`Deposit poller: initial sweep error: ${err.message}`);
  });

  const timer = setInterval(() => {
    runDepositSweep(deps).catch((err) => {
      logger.error(`Deposit poller: sweep error: ${err.message}`);
    });
  }, intervalMs);

  // Unref so the timer doesn't prevent the process from exiting on SIGTERM.
  if (timer.unref) timer.unref();

  const stop = () => {
    clearInterval(timer);
    logger.info('Deposit poller stopped.');
  };

  return { stop };
};

module.exports = {
  startDepositPoller,
  // Exported for unit tests and outbox management
  formatDepositMessage,
  pollWallet,
  runDepositSweep,
  processDepositOutbox,
  replayFailedDepositOutboxRecord,
  replayAllDeadLetters,
  cleanupDeliveredOutboxRecords,
  listDepositOutboxRecords,
  listUndeliveredDepositOutboxRecords,
  findStuckDepositOutboxRecords,
};

