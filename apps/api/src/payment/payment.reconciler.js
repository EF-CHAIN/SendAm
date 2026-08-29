const logger = require('../utils/logger');
const defaultHorizonServer = () => require('../config/stellar').server;
const writeAuditLog = async (args) => {
  try {
    return await require('../common/audit.service').writeAuditLog(args);
  } catch {
    return null;
  }
};
const transactionUrl = (hash) => {
  try {
    return require('../wallet/stellar.adapter').getTransactionUrl(hash);
  } catch {
    return `https://stellar.expert/explorer/testnet/tx/${hash}`;
  }
};

// Stellar transactions are built with setTimeout(30), meaning the network
// will reject the envelope if it isn't included within ~30 ledger-closes
// (~2.5 minutes at 5s/ledger). We give a generous buffer beyond that before
// treating a missing hash as definitively expired.
const LEDGER_SEQUENCE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes — safely beyond setTimeout(30)

// A Horizon 404 for a txHash that was submitted recently can simply mean the
// ledger hasn't propagated to the node we hit yet (ingestion lag). We only
// treat the 404 as conclusive once the ledger sequence window has closed.
const isLedgerSequenceExpired = (tx, nowMs = Date.now()) => {
  return (new Date(tx.createdAt).getTime() + LEDGER_SEQUENCE_WINDOW_MS) < nowMs;
};

// Reconciles stuck transactions in 'processing' or 'pending' state by querying Horizon.
// Finality policy:
//   confirmed  → Horizon reports txHash present in a closed ledger (successful=true)
//   expired    → txHash 404 AND ledger sequence window has closed
//   pending    → txHash 404 but window still open (transient ingestion lag — retry next cycle)
//   failed     → definitive Horizon failure response OR exceeded max stale age
const reconcileStaleTransactions = async ({
  prisma,
  staleAgeMs = 5 * 60 * 1000, // 5 minutes
  maxTransactions = 50,
  horizonServer,
  loggerInstance = logger,
  onReceipt = null, // optional callback(tx) called when a tx transitions to success
} = {}) => {
  const horizon = horizonServer || defaultHorizonServer();
  const cutoff = new Date(Date.now() - staleAgeMs);

  const staleTransactions = await prisma.transaction.findMany({
    where: {
      status: { in: ['processing', 'pending'] },
      createdAt: { lte: cutoff },
    },
    take: maxTransactions,
    include: {
      user: {
        include: {
          wallets: {
            where: { chain: 'stellar' },
          },
        },
      },
    },
  });

  if (staleTransactions.length === 0) {
    return { processedCount: 0, updatedCount: 0 };
  }

  let updatedCount = 0;

  for (const tx of staleTransactions) {
    try {
      // 1. If we have a txHash, verify it on Horizon before anything else.
      if (tx.txHash) {
        let horizonTx = null;
        let notFound = false;

        try {
          horizonTx = await horizon.transactions().transactionHash(tx.txHash).call();
        } catch (err) {
          if (err.response?.status === 404) {
            notFound = true;
          } else {
            loggerInstance.warn(`Horizon error checking txHash ${tx.txHash} for tx ${tx.id}: ${err.message}`);
          }
        }
        if (horizonTx && horizonTx.successful) {
          // ✅ Confirmed — ledger-backed finality achieved.
          const updated = await prisma.transaction.update({
            where: { id: tx.id },
            data: {
              status: 'success',
              explorerUrl: transactionUrl(tx.txHash),
              metadata: {
                ...tx.metadata,
                confirmedAt: new Date().toISOString(),
              },
            },
          });
          updatedCount += 1;
          loggerInstance.info(`Reconciled transaction ${tx.id} to success via txHash ${tx.txHash}`);

          // Issue the customer receipt now that finality is confirmed.
          if (onReceipt) {
            try { await onReceipt(updated); } catch (e) { loggerInstance.warn(`Receipt callback failed for tx ${tx.id}: ${e.message}`); }
          }
          continue;
        }

        if (horizonTx && !horizonTx.successful) {
          // ❌ Definitive on-chain failure (e.g. op_underfunded recorded on ledger).
          await prisma.transaction.update({
            where: { id: tx.id },
            data: {
              status: 'failed',
              metadata: {
                ...tx.metadata,
                reconciliationError: 'Transaction included in ledger but marked unsuccessful.',
                failedAt: new Date().toISOString(),
              },
            },
          });
          updatedCount += 1;
          loggerInstance.info(`Reconciled transaction ${tx.id} to failed — ledger marked unsuccessful`);
          continue;
        }

        if (notFound) {
          if (!isLedgerSequenceExpired(tx)) {
            // ⏳ 404 but the ledger sequence window is still open — this is a
            // transient ingestion delay, not a failure. Leave as pending and
            // retry on the next reconciliation cycle.
            loggerInstance.info(`Transaction ${tx.id} txHash ${tx.txHash} returned 404 — ledger window still open, will retry`);
            continue;
          }

          // ❌ 404 + window closed = ledger sequence definitively expired.
          await prisma.transaction.update({
            where: { id: tx.id },
            data: {
              status: 'expired',
              metadata: {
                ...tx.metadata,
                reconciliationError: 'ledger_sequence_expired',
                expiredAt: new Date().toISOString(),
              },
            },
          });
          updatedCount += 1;
          loggerInstance.info(`Reconciled transaction ${tx.id} to expired — txHash not found after ledger sequence window closed`);
          continue;
        }
      }

      // 2. No txHash: query sender wallet payment history on Horizon.
      const senderPublicKey = tx.user?.wallets?.[0]?.publicKey;
      if (senderPublicKey) {
        try {
          const paymentsResponse = await horizon.payments().forAccount(senderPublicKey).order('desc').limit(20).call();
          const matchingPayment = paymentsResponse.records.find((p) => {
            const isPayment = p.type === 'payment';
            const amountMatches = String(p.amount) === String(tx.amount);
            const toMatches = !tx.destination || p.to === tx.destination;
            return isPayment && amountMatches && toMatches;
          });

          if (matchingPayment) {
            const hash = matchingPayment.transaction_hash;
            const updated = await prisma.transaction.update({
              where: { id: tx.id },
              data: {
                status: 'success',
                txHash: hash,
                explorerUrl: transactionUrl(hash),
                metadata: {
                  ...tx.metadata,
                  confirmedAt: new Date().toISOString(),
                },
              },
            });
            updatedCount += 1;
            loggerInstance.info(`Reconciled transaction ${tx.id} to success via payment history match on ${senderPublicKey}`);

            if (onReceipt) {
              try { await onReceipt(updated); } catch (e) { loggerInstance.warn(`Receipt callback failed for tx ${tx.id}: ${e.message}`); }
            }
            continue;
          }
        } catch (err) {
          loggerInstance.warn(`Horizon error checking payment history for account ${senderPublicKey}: ${err.message}`);
        }
      }

      // 3. No Horizon match found. Only mark failed after the maximum stale
      //    age AND the ledger sequence window is confirmed closed — never on
      //    wall-clock alone if the window could still be open.
      const maxStaleCutoff = new Date(Date.now() - staleAgeMs * 3);
      if (tx.createdAt <= maxStaleCutoff && isLedgerSequenceExpired(tx)) {
        await prisma.transaction.update({
          where: { id: tx.id },
          data: {
            status: 'failed',
            metadata: {
              ...tx.metadata,
              reconciliationError: 'ledger_sequence_expired',
              failedAt: new Date().toISOString(),
            },
          },
        });
        updatedCount += 1;
        loggerInstance.info(`Reconciled stale transaction ${tx.id} to failed — ledger sequence expired, no on-chain evidence`);
      }
    } catch (err) {
      loggerInstance.error(`Error reconciling transaction ${tx.id}`, err.message);
    }
  }

  return { processedCount: staleTransactions.length, updatedCount };
};

const { decimalToRatio, getAssetRule, parseUnits } = require('../utils/money');

const canonicalizeMonetaryAmount = (amountStr, assetCode) => {
  if (amountStr == null || String(amountStr).trim() === '') return null;
  const rule = getAssetRule(assetCode);
  const ratio = decimalToRatio(amountStr);
  const factor = 10n ** BigInt(rule.precision);
  const rounded = (ratio.numerator * factor + ratio.denominator / 2n) / ratio.denominator;
  const whole = rounded / factor;
  const frac = (rounded % factor).toString().padStart(rule.precision, '0');
  return rule.precision > 0 ? `${whole}.${frac}` : `${whole}`;
};

const reconcileMonetaryValues = async ({
  prisma,
  apply = false,
  maxRecords = 1000,
  loggerInstance = logger,
} = {}) => {
  let checkedCount = 0;
  let invalidCount = 0;
  let fixedCount = 0;
  const errors = [];

  try {
    const quotes = await prisma.quote.findMany({
      take: maxRecords,
      orderBy: { createdAt: 'desc' },
    });

    for (const q of quotes) {
      checkedCount += 1;
      let needsFix = false;
      const updates = {};

      try {
        if (q.sourceAmount && q.sourceCurrency) {
          const canonical = canonicalizeMonetaryAmount(q.sourceAmount, q.sourceCurrency);
          if (canonical !== String(q.sourceAmount)) {
            needsFix = true;
            updates.sourceAmount = canonical;
          }
        }
        if (q.targetAmount && q.targetCurrency) {
          const canonical = canonicalizeMonetaryAmount(q.targetAmount, q.targetCurrency);
          if (canonical !== String(q.targetAmount)) {
            needsFix = true;
            updates.targetAmount = canonical;
          }
        }
        if (q.fee && q.sourceCurrency) {
          const canonical = canonicalizeMonetaryAmount(q.fee, q.sourceCurrency);
          if (canonical !== String(q.fee)) {
            needsFix = true;
            updates.fee = canonical;
          }
        }
        if (q.rate != null) {
          const canonicalRate = decimalToRatio(q.rate).decimal;
          if (canonicalRate !== String(q.rate)) {
            needsFix = true;
            updates.rate = canonicalRate;
          }
        }

        if (needsFix) {
          invalidCount += 1;
          if (apply) {
            await prisma.quote.update({
              where: { id: q.id },
              data: updates,
            });
            fixedCount += 1;
            loggerInstance.info(`Reconciled Quote ${q.id} monetary fields: ${JSON.stringify(updates)}`);
          }
        }
      } catch (err) {
        errors.push({ id: q.id, type: 'Quote', error: err.message });
      }
    }

    const transactions = await prisma.transaction.findMany({
      take: maxRecords,
      orderBy: { createdAt: 'desc' },
    });

    for (const tx of transactions) {
      checkedCount += 1;
      let needsFix = false;
      const updates = {};

      try {
        if (tx.amount && tx.asset) {
          const canonical = canonicalizeMonetaryAmount(tx.amount, tx.asset);
          if (canonical !== String(tx.amount)) {
            needsFix = true;
            updates.amount = canonical;
          }
        }

        if (needsFix) {
          invalidCount += 1;
          if (apply) {
            await prisma.transaction.update({
              where: { id: tx.id },
              data: updates,
            });
            fixedCount += 1;
            loggerInstance.info(`Reconciled Transaction ${tx.id} monetary fields: ${JSON.stringify(updates)}`);
          }
        }
      } catch (err) {
        errors.push({ id: tx.id, type: 'Transaction', error: err.message });
      }
    }
  } catch (err) {
    loggerInstance.error('Error during monetary reconciliation', err.message);
    errors.push({ error: err.message });
  }

  return { checkedCount, invalidCount, fixedCount, errors };
};

const signedUnits = (amount, asset) => {
  const raw = String(amount || '0').trim();
  const sign = raw.startsWith('-') ? -1n : 1n;
  const rule = getAssetRule(asset);
  return sign * parseUnits(raw.replace(/^-/, '') || '0', rule.precision);
};

const sumPostingsByAsset = (postings = []) => {
  const totals = new Map();
  for (const posting of postings) {
    totals.set(posting.asset, (totals.get(posting.asset) || 0n) + signedUnits(posting.amount, posting.asset));
  }
  return totals;
};

const listLedgerDiscrepancies = async ({ prisma, maxEntries = 500 } = {}) => {
  const entries = await prisma.journalEntry.findMany({
    take: maxEntries,
    orderBy: { createdAt: 'desc' },
    include: { postings: true, transaction: true },
  });
  const discrepancies = [];
  for (const entry of entries) {
    const totals = sumPostingsByAsset(entry.postings);
    for (const [asset, total] of totals.entries()) {
      if (total !== 0n) {
        discrepancies.push({ type: 'unbalanced_entry', journalEntryId: entry.id, transactionId: entry.transactionId, asset });
      }
    }
    if (entry.eventType === 'payment.settled' && entry.transaction && entry.transaction.status !== 'success') {
      discrepancies.push({ type: 'ledger_stellar_state_mismatch', journalEntryId: entry.id, transactionId: entry.transactionId, status: entry.transaction.status });
    }
  }
  return { checkedCount: entries.length, discrepancyCount: discrepancies.length, discrepancies };
};

const listStuckPayments = async ({
  prisma,
  staleAgeMs = 15 * 60 * 1000,
  maxTransactions = 50,
} = {}) => {
  const cutoff = new Date(Date.now() - staleAgeMs);
  const payments = await prisma.transaction.findMany({
    where: {
      status: { in: ['processing', 'pending', 'escalated'] },
      createdAt: { lte: cutoff },
    },
    take: maxTransactions,
    orderBy: { createdAt: 'asc' },
    include: {
      ledgerEntries: { include: { postings: { include: { account: true } } }, orderBy: { createdAt: 'asc' } },
      user: { select: { phoneNumber: true } },
    },
  });

  return payments.map((payment) => ({
    ...payment,
    retryHistory: Array.isArray(payment.metadata?.retryHistory) ? payment.metadata.retryHistory : [],
    ledgerEvidence: payment.ledgerEntries,
  }));
};

const requireReason = (reason) => {
  const text = String(reason || '').trim();
  if (text.length < 5) throw new Error('A reason of at least 5 characters is required.');
  return text;
};

const operatorResolveStuckPayment = async ({
  prisma,
  transactionId,
  action,
  reason,
  adminId,
  now = new Date(),
} = {}) => {
  const cleanReason = requireReason(reason);
  const allowed = new Set(['retry', 'mark_resolved', 'escalate']);
  if (!allowed.has(action)) throw new Error('Invalid stuck payment action.');

  return prisma.$transaction(async (tx) => {
    const transaction = await tx.transaction.findUnique({ where: { id: transactionId } });
    if (!transaction) throw new Error('Transaction not found.');
    if (['success', 'resolved'].includes(transaction.status)) {
      throw new Error('Settled or resolved payments cannot be retried.');
    }

    const metadata = typeof transaction.metadata === 'object' && transaction.metadata !== null ? transaction.metadata : {};
    const retryHistory = Array.isArray(metadata.retryHistory) ? metadata.retryHistory : [];
    const actionEvent = { action, reason: cleanReason, adminId, at: now.toISOString() };
    const nextStatus = action === 'retry' ? 'processing' : action === 'mark_resolved' ? 'resolved' : 'escalated';
    const nextMetadata = {
      ...metadata,
      retryHistory: action === 'retry' ? [...retryHistory, actionEvent] : retryHistory,
      operatorActions: [...(Array.isArray(metadata.operatorActions) ? metadata.operatorActions : []), actionEvent],
      resolvedAt: action === 'mark_resolved' ? now.toISOString() : metadata.resolvedAt,
      escalatedAt: action === 'escalate' ? now.toISOString() : metadata.escalatedAt,
    };

    const updated = await tx.transaction.update({
      where: { id: transaction.id },
      data: { status: nextStatus, metadata: nextMetadata },
    });

    const audit = {
      actorType: 'administrator',
      actorId: adminId,
      action: `admin.payment.${action}`,
      entityType: 'Transaction',
      entityId: transaction.id,
      metadata: { reason: cleanReason, previousStatus: transaction.status, nextStatus },
    };
    if (tx.auditLog?.create) await tx.auditLog.create({ data: audit });
    else await writeAuditLog(audit);

    return updated;
  });
};

module.exports = {
  reconcileStaleTransactions,
  reconcileMonetaryValues,
  listLedgerDiscrepancies,
  listStuckPayments,
  operatorResolveStuckPayment,
};
