const defaultLogger = require('../utils/logger');
const { transitionPaymentState } = require('./payment.transitions');

const markTransactionFailed = async ({ prisma, transactionId, metadata, error, logger = defaultLogger }) => {
  try {
    await transitionPaymentState({
      db: prisma,
      transactionId,
      toState: 'failed',
      actor: { type: 'system', id: 'orchestrator' },
      reason: error?.message || 'Transaction failed',
      metadata,
    });
  } catch (updateError) {
    logger.error(
      `Could not record failed status for transaction ${transactionId}; preserving the original error`,
      updateError.message
    );
  }
};

module.exports = { markTransactionFailed };

