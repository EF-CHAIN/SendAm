'use strict';

// End-of-day ledger reconciliation (#1003).
//
// Compares the Stellar ledger (Horizon) with the local database for the
// preceding 24 hours and produces an audit report. For every platform-held
// Stellar wallet it reads the payment operations closed in the window, then
// matches them to Transaction rows by hash and amount. Findings:
//
//   missing_in_db        on-chain outgoing payment with no database record
//   missing_on_chain     database says confirmed, but the hash is not on the ledger
//   pending_but_on_chain database still pending/processing though the ledger closed it
//   amount_mismatch      hash matches but amounts differ (compared in exact stroops)
//   status_mismatch      database and ledger disagree about success/failure
//   stale_pending        pending with no hash well after the grace period
//
// The job only detects and reports: it never rewrites transaction state.
// Payments stay with payment.reconciler, which owns state transitions.

const logger = require('../utils/logger');
const { toStroops } = require('../utils/money');

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 200;
const MAX_PAGES_PER_ACCOUNT = 50;
const MAX_REPORTED_DISCREPANCIES = 500;
const DEFAULT_RUN_HOUR_UTC = 0;
const SCHEDULER_TICK_MS = 10 * 60 * 1000;
const STALE_PENDING_GRACE_MS = 60 * 60 * 1000;
const REPORT_ACTION = 'reconciliation.daily_report';

const DISCREPANCY = Object.freeze({
  MISSING_IN_DB: 'missing_in_db',
  MISSING_ON_CHAIN: 'missing_on_chain',
  PENDING_BUT_ON_CHAIN: 'pending_but_on_chain',
  AMOUNT_MISMATCH: 'amount_mismatch',
  STATUS_MISMATCH: 'status_mismatch',
  STALE_PENDING: 'stale_pending',
});

const OPEN_STATUSES = ['pending', 'processing', 'escalated'];
const DEAD_STATUSES = ['failed', 'cancelled', 'expired'];

const defaultPrisma = () => require('../common/prisma');
const defaultHorizon = () => require('../config/stellar').server;

const safeStroops = (value) => {
  try {
    return toStroops(value);
  } catch (_error) {
    return null;
  }
};

const amountsEqual = (a, b) => {
  const left = safeStroops(a);
  const right = safeStroops(b);
  return left !== null && right !== null && left === right;
};

const chainAssetCode = (record) => (record.asset_type === 'native' ? 'XLM' : record.asset_code);

const assetMatches = (record, asset) => !asset
  || String(asset).toUpperCase() === String(chainAssetCode(record) || '').toUpperCase();

/** Outgoing payment operations closed on Horizon for one account since `since`. */
const fetchOutgoingPayments = async ({ horizon, publicKey, since }) => {
  const found = [];
  let page = await horizon.payments().forAccount(publicKey).order('desc').limit(PAGE_SIZE)
    .includeFailed(true)
    .call();
  for (let pages = 0; pages < MAX_PAGES_PER_ACCOUNT; pages += 1) {
    const records = page.records || [];
    if (records.length === 0) break;
    let reachedWindowStart = false;
    for (const record of records) {
      if (new Date(record.created_at) < since) {
        reachedWindowStart = true;
        break;
      }
      if (record.type === 'payment' && record.from === publicKey) found.push(record);
    }
    if (reachedWindowStart || records.length < PAGE_SIZE) break;
    page = await page.next();
  }
  return found;
};

const listPlatformAccounts = async (prisma, network) => {
  const wallets = await prisma.wallet.findMany({
    where: { chain: 'stellar', ...(network ? { network } : {}), publicKey: { not: null } },
    select: { publicKey: true },
  });
  return [...new Set(wallets.map((wallet) => wallet.publicKey))];
};

const isNotFound = (error) => error?.response?.status === 404 || error?.name === 'NotFoundError';

const runLedgerReconciliation = async ({
  prisma = defaultPrisma(),
  horizonServer,
  now = () => new Date(),
  windowMs = DAY_MS,
  network,
  audit,
  log = logger,
} = {}) => {
  const horizon = horizonServer || defaultHorizon();
  const writeAudit = audit || require('../common/audit.service').writeAuditLog;
  const windowEnd = now();
  const windowStart = new Date(windowEnd.getTime() - windowMs);
  const discrepancies = [];
  const add = (type, details) => discrepancies.push({ type, ...details });

  const accounts = await listPlatformAccounts(prisma, network);

  // 1. Ledger side: outgoing payments (successful and failed), deduped by hash.
  const onChain = new Map();
  const scanErrors = [];
  for (const publicKey of accounts) {
    try {
      const payments = await fetchOutgoingPayments({ horizon, publicKey, since: windowStart });
      for (const payment of payments) {
        const hash = payment.transaction_hash;
        if (!onChain.has(hash)) onChain.set(hash, { hash, payment, publicKey });
      }
    } catch (error) {
      // A partial scan must never be reported as clean.
      scanErrors.push({ publicKey, message: error.message });
      log.warn('ledger_reconciliation_account_failed', { publicKey, message: error.message });
    }
  }

  // 2. Database side: stellar transactions created in the window, plus any row
  // matching a hash seen on-chain (it may have been created just before it).
  const hashes = [...onChain.keys()];
  const dbRows = await prisma.transaction.findMany({
    where: {
      rail: 'stellar',
      OR: [
        { createdAt: { gte: windowStart, lte: windowEnd } },
        ...(hashes.length ? [{ txHash: { in: hashes } }] : []),
      ],
    },
    select: {
      id: true, txHash: true, amount: true, asset: true, status: true, createdAt: true,
    },
  });
  const dbByHash = new Map(dbRows.filter((row) => row.txHash).map((row) => [row.txHash, row]));

  // 3. Ledger -> database.
  for (const { hash, payment } of onChain.values()) {
    const row = dbByHash.get(hash);
    const chainOk = payment.transaction_successful !== false;
    if (!row) {
      if (chainOk) {
        add(DISCREPANCY.MISSING_IN_DB, {
          txHash: hash, chainAmount: payment.amount, source: payment.from, destination: payment.to,
        });
      }
      continue;
    }
    if (!chainOk) {
      if (row.status === 'success') {
        add(DISCREPANCY.STATUS_MISMATCH, {
          transactionId: row.id, txHash: hash, dbStatus: row.status, chainStatus: 'failed',
        });
      }
      continue;
    }
    if (OPEN_STATUSES.includes(row.status)) {
      add(DISCREPANCY.PENDING_BUT_ON_CHAIN, {
        transactionId: row.id, txHash: hash, dbStatus: row.status, chainStatus: 'success',
      });
    } else if (DEAD_STATUSES.includes(row.status)) {
      add(DISCREPANCY.STATUS_MISMATCH, {
        transactionId: row.id, txHash: hash, dbStatus: row.status, chainStatus: 'success',
      });
    }
    if (!amountsEqual(row.amount, payment.amount) || !assetMatches(payment, row.asset)) {
      add(DISCREPANCY.AMOUNT_MISMATCH, {
        transactionId: row.id,
        txHash: hash,
        dbAmount: row.amount,
        dbAsset: row.asset,
        chainAmount: payment.amount,
        chainAsset: chainAssetCode(payment),
      });
    }
  }

  // 4. Database -> ledger.
  for (const row of dbRows) {
    if (row.txHash && onChain.has(row.txHash)) continue;
    if (row.status === 'success' && row.txHash) {
      // Not seen in the scan; confirm directly before calling it missing.
      try {
        const tx = await horizon.transactions().transaction(row.txHash).call();
        if (tx && tx.successful === false) {
          add(DISCREPANCY.STATUS_MISMATCH, {
            transactionId: row.id, txHash: row.txHash, dbStatus: row.status, chainStatus: 'failed',
          });
        }
      } catch (error) {
        if (isNotFound(error)) {
          add(DISCREPANCY.MISSING_ON_CHAIN, {
            transactionId: row.id, txHash: row.txHash, dbStatus: row.status, dbAmount: row.amount,
          });
        } else {
          scanErrors.push({ txHash: row.txHash, message: error.message });
        }
      }
    } else if (OPEN_STATUSES.includes(row.status) && !row.txHash
      && windowEnd.getTime() - new Date(row.createdAt).getTime() > STALE_PENDING_GRACE_MS) {
      add(DISCREPANCY.STALE_PENDING, {
        transactionId: row.id, dbStatus: row.status, dbAmount: row.amount, createdAt: row.createdAt,
      });
    }
  }

  const counts = discrepancies.reduce((acc, item) => ({ ...acc, [item.type]: (acc[item.type] || 0) + 1 }), {});
  const report = {
    reportDate: windowEnd.toISOString().slice(0, 10),
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    accountsScanned: accounts.length,
    scanErrors,
    onChainPayments: onChain.size,
    databaseTransactions: dbRows.length,
    discrepancyCount: discrepancies.length,
    counts,
    complete: scanErrors.length === 0,
    truncated: discrepancies.length > MAX_REPORTED_DISCREPANCIES,
    discrepancies: discrepancies.slice(0, MAX_REPORTED_DISCREPANCIES),
  };

  // 5. Flag database-linked findings for operator review (one open item each).
  let checkpointsCreated = 0;
  for (const item of discrepancies.filter((entry) => entry.transactionId)) {
    try {
      const existing = await prisma.reconciliationCheckpoint.findFirst({
        where: { transactionId: item.transactionId, checkpointType: 'ledger_horizon', status: 'mismatch' },
        select: { id: true },
      });
      if (existing) continue;
      await prisma.reconciliationCheckpoint.create({
        data: {
          transactionId: item.transactionId,
          checkpointType: 'ledger_horizon',
          status: 'mismatch',
          mismatchDetails: { ...item, detectedAt: windowEnd.toISOString() },
          evidence: { reportDate: report.reportDate },
        },
      });
      checkpointsCreated += 1;
    } catch (error) {
      log.warn('ledger_reconciliation_checkpoint_failed', { transactionId: item.transactionId, message: error.message });
    }
  }
  report.checkpointsCreated = checkpointsCreated;

  // 6. Audit report. Failing to persist it fails the run rather than hiding it.
  await writeAudit({
    actorType: 'system',
    actorId: 'ledger-reconciliation',
    action: REPORT_ACTION,
    entityType: 'LedgerReconciliation',
    entityId: report.reportDate,
    metadata: report,
  });

  log.info('ledger_reconciliation_completed', {
    reportDate: report.reportDate,
    accountsScanned: report.accountsScanned,
    discrepancyCount: report.discrepancyCount,
    complete: report.complete,
  });
  return report;
};

/**
 * Daily scheduler. Fires once per UTC day after `runHourUtc`. A report already
 * written for the same date (by any replica) suppresses the run, so several
 * workers do not duplicate it.
 */
const startLedgerReconciliationScheduler = ({
  prisma,
  runHourUtc = Number(process.env.LEDGER_RECONCILIATION_HOUR_UTC || DEFAULT_RUN_HOUR_UTC),
  tickMs = SCHEDULER_TICK_MS,
  run = runLedgerReconciliation,
  now = () => new Date(),
  log = logger,
} = {}) => {
  let running = false;

  const tick = async () => {
    const current = now();
    if (running || current.getUTCHours() < runHourUtc) return null;
    running = true;
    try {
      const db = prisma || defaultPrisma();
      const reportDate = current.toISOString().slice(0, 10);
      const already = await db.auditLog.findFirst({
        where: { action: REPORT_ACTION, entityType: 'LedgerReconciliation', entityId: reportDate },
        select: { id: true },
      });
      if (already) return null;
      return await run({ prisma: db, now });
    } catch (error) {
      log.error('ledger_reconciliation_failed', { message: error.message });
      return null;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, tickMs);
  if (timer.unref) timer.unref();
  log.info('ledger_reconciliation_scheduler_started', { runHourUtc, tickMs });
  return { tick, stop: () => clearInterval(timer) };
};

module.exports = {
  runLedgerReconciliation,
  startLedgerReconciliationScheduler,
  DISCREPANCY,
  REPORT_ACTION,
};
