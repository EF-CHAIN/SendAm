// Deposit poller — #31
//
// Background loop that watches every Stellar wallet for inbound payments and
// notifies the owner over WhatsApp/sim.  Runs as a plain in-process
// setInterval (no Redis/BullMQ dependency at this scale).
//
// Design rules (from the issue spec):
//
//  1. New inbound payment → exactly one notification, cursor advanced.
//  2. Re-running with the same cursor → zero notifications.
//  3. Outbound payments and old history never notify.
//  4. One failing wallet never stalls the loop.
//  5. cursor-before-notify: the cursor is written to the DB *before* the
//     message is sent.  If the process dies between the two steps the user
//     misses one notification — that is a better outcome than the user
//     receiving a duplicate "you received money" alert.
//  6. First poll of a null-cursor wallet: initialise cursor to the latest
//     Horizon paging token without notifying.  This prevents replaying
//     the entire payment history when a wallet is first seen by the poller.
//
// The notify function defaults to whatsapp.service.sendTextMessage so the
// module is injected in tests without touching require.cache.

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

// ---------------------------------------------------------------------------
// Per-wallet poll
// ---------------------------------------------------------------------------

/**
 * Poll one wallet for new inbound payments.
 *
 * @param {object} wallet   - Prisma Wallet row (needs id, publicKey, phoneNumber, paymentCursor)
 * @param {object} deps     - { horizon, prismaClient, notify, fetchRate }
 */
const pollWallet = async (wallet, deps) => {
  const { horizon, prismaClient, notify, fetchRate } = deps;
  const { id, publicKey, phoneNumber, paymentCursor } = wallet;

  const isFirstPoll = paymentCursor == null;

  const { records, nextCursor } = await fetchPaymentsPage(horizon, publicKey, paymentCursor);

  // Rule 6: first poll — initialise cursor without notifying.
  if (isFirstPoll) {
    if (nextCursor != null) {
      await prismaClient.wallet.update({
        where: { id },
        data: { paymentCursor: nextCursor },
      });
    }
    return;
  }

  // Filter to inbound payment_type records only (exclude create_account, etc.)
  // and exclude outbound (where the source account is this wallet).
  const inbound = records.filter(
    (r) =>
      r.type === 'payment' &&
      r.to === publicKey,
  );

  if (inbound.length === 0) {
    // No new inbound payments; advance cursor if records moved it anyway
    // (e.g. only outbound records on the page).
    if (nextCursor !== paymentCursor) {
      await prismaClient.wallet.update({
        where: { id },
        data: { paymentCursor: nextCursor },
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

  for (const record of inbound) {
    const amount = record.amount;
    const asset =
      record.asset_type === 'native' ? 'native' : (record.asset_code || record.asset_type);

    const newCursor = record.paging_token;

    // Rule 5: write cursor BEFORE sending the notification.
    await prismaClient.wallet.update({
      where: { id },
      data: { paymentCursor: newCursor },
    });

    const message = formatDepositMessage(amount, asset, fiatRate);
    await notify(phoneNumber, message);
  }

  // If the page advanced past the last inbound (e.g. outbound records
  // after the last inbound), persist the final cursor too.
  if (nextCursor !== paymentCursor) {
    const currentCursor = (await prismaClient.wallet.findUnique({ where: { id }, select: { paymentCursor: true } }))?.paymentCursor;
    if (currentCursor !== nextCursor) {
      await prismaClient.wallet.update({
        where: { id },
        data: { paymentCursor: nextCursor },
      });
    }
  }
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
      select: { id: true, publicKey: true, phoneNumber: true, paymentCursor: true },
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
  // Exported for unit tests only — not part of the public API.
  formatDepositMessage,
  pollWallet,
  runDepositSweep,
};
