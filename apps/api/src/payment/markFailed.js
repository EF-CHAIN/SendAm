const defaultLogger = require('../utils/logger');
const { transitionPaymentState } = require('./payment.transitions');

const normalizePaymentStatus = (status) => {
  const value = String(status ?? '').trim().toLowerCase();
  const aliases = {
    processing: 'pending',
    pending: 'pending',
    submitted: 'pending',
    success: 'success',
    settled: 'success',
    completed: 'success',
    failed: 'failed',
    rejected: 'failed',
    expired: 'failed',
    cancelled: 'cancelled',
    canceled: 'cancelled',
    superseded: 'cancelled',
    reversed: 'reversed',
    resolved: 'success',
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
    await transitionPaymentState({
      db: prisma,
      transactionId,
      toState: normalized,
      actor: { type: 'system', id: 'system' },
      reason: reason || null,
      metadata: {
        ...metadata,
        [timestampField]: eventTime,
        ...(reason ? { [reasonField]: reason } : {}),
      },
    });
  } catch (updateError) {
    logger.error(`Could not record ${status} status for transaction ${transactionId}; preserving the original error`, updateError.message);
  }
};

const markTransactionFailed = async ({ prisma, transactionId, metadata, error, logger = defaultLogger }) => {
  try {
    const errMsg = error instanceof Error ? error.message : String(error || 'unknown');
    await transitionPaymentState({
      db: prisma,
      transactionId,
      toState: 'failed',
      actor: { type: 'system', id: 'orchestrator' },
      reason: errMsg,
      metadata: { ...metadata, error: errMsg },
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
