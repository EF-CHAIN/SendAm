// Failure-path bookkeeping for executePayment. Marking the transaction row
// 'failed' happens inside the orchestrator's catch — if THAT update also
// rejects (database hiccup mid-incident), the bookkeeping error must not
// replace the original payment error the caller needs to see. prisma is
// injected so this stays unit-testable offline.
const defaultLogger = require('../utils/logger');

const normalizePaymentStatus = (status) => {
  const value = String(status ?? '').trim().toLowerCase();
  const aliases = {
    processing: 'pending',
    pending: 'pending',
    submitted: 'pending',
    success: 'settled',
    settled: 'settled',
    completed: 'settled',
    failed: 'failed',
    rejected: 'failed',
    expired: 'failed',
    cancelled: 'cancelled',
    canceled: 'cancelled',
    superseded: 'cancelled',
    reversed: 'reversed',
    resolved: 'settled',
    in_progress: 'pending',
  };
  return aliases[value] || value || 'pending';
};

const updateTransactionLifecycle = async ({
  prisma,
  transactionId,
  status,
  metadata,
  reasonField,
  reason,
  logger = defaultLogger,
  timestampField,
}) => {
  try {
    const normalized = normalizePaymentStatus(status);
    const eventTime = new Date().toISOString();
    await prisma.transaction.update({
      where: { id: transactionId },
      data: {
        status: normalized,
        metadata: {
          ...metadata,
          [timestampField]: eventTime,
          ...(reason ? { [reasonField]: reason } : {}),
        },
      },
    });
  } catch (updateError) {
    logger.error(`Could not record ${status} status for transaction ${transactionId}; preserving the original error`, updateError.message);
  }
};

const markTransactionFailed = async ({ prisma, transactionId, metadata, error, logger = defaultLogger }) => {
  try {
    await prisma.transaction.update({
      where: { id: transactionId },
      data: {
        status: 'failed',
        metadata: { ...metadata, error: error instanceof Error ? error.message : String(error || 'unknown') },
      },
    });
  } catch (updateError) {
    logger.error(
      `Could not record failed status for transaction ${transactionId}; preserving the original error`,
      updateError.message
    );
  }
};

const markTransactionCancelled = async ({ prisma, transactionId, metadata, reason, logger = defaultLogger }) => {
  await updateTransactionLifecycle({
    prisma,
    transactionId,
    status: 'cancelled',
    metadata,
    reasonField: 'cancellationReason',
    reason,
    logger,
    timestampField: 'cancelledAt',
  });
};

const markTransactionReversed = async ({ prisma, transactionId, metadata, reason, logger = defaultLogger }) => {
  await updateTransactionLifecycle({
    prisma,
    transactionId,
    status: 'reversed',
    metadata,
    reasonField: 'reversalReason',
    reason,
    logger,
    timestampField: 'reversedAt',
  });
};

module.exports = {
  normalizePaymentStatus,
  markTransactionFailed,
  markTransactionCancelled,
  markTransactionReversed,
};
