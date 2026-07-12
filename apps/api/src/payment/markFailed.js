// Failure-path bookkeeping for executePayment. Marking the transaction row
// 'failed' happens inside the orchestrator's catch — if THAT update also
// rejects (database hiccup mid-incident), the bookkeeping error must not
// replace the original payment error the caller needs to see. prisma is
// injected so this stays unit-testable offline.
const defaultLogger = require('../utils/logger');

const markTransactionFailed = async ({ prisma, transactionId, metadata, error, logger = defaultLogger }) => {
  try {
    await prisma.transaction.update({
      where: { id: transactionId },
      data: {
        status: 'failed',
        metadata: { ...metadata, error: error.message },
      },
    });
  } catch (updateError) {
    logger.error(
      `Could not record failed status for transaction ${transactionId}; preserving the original error`,
      updateError.message
    );
  }
};

module.exports = { markTransactionFailed };
