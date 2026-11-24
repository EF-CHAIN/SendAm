'use strict';

// Automated Stellar Payment Failure Detection and Instant Fiat Refund Dispatch (#1000).
//
// Target Area: apps/api/src/payment/refundEngine.js
// Catches Stellar Horizon rejection errors (e.g., invalid memo, expired/missing trustline,
// underfunded account, or bad sequence rejection); triggers immediate BullMQ reversal job;
// credits internal balance/ledger (customer_money) and dispatches user notification over WhatsApp.

const logger = require('../utils/logger');
const defaultPrisma = () => require('../common/prisma');
const { enqueue } = require('../queues/queue.service');
const { transitionPaymentState } = require('./payment.transitions');
const ledger = require('./ledger.service');
const { sendTextMessage } = require('../services/whatsapp.service');

const QUEUE_NAME = 'payment-reversals';
const JOB_NAME = 'payment.reversal';

/**
 * Recognised Stellar Horizon error codes and classifications.
 */
const STELLAR_ERROR_CODES = Object.freeze({
  INVALID_MEMO: 'invalid_memo',
  MISSING_OR_EXPIRED_TRUSTLINE: 'missing_or_expired_trustline',
  OP_UNDERFUNDED: 'op_underfunded',
  OP_NO_DESTINATION: 'op_no_destination',
  OP_LINE_FULL: 'op_line_full',
  TX_BAD_SEQ: 'tx_bad_seq',
  TX_FAILED: 'tx_failed',
  UNKNOWN_STELLAR_ERROR: 'unknown_stellar_error',
});

/**
 * Classifies an error to determine if it is a Stellar rejection eligible for instant refund.
 *
 * @param {Error|object} error - The caught error
 * @returns {{ isStellarFailure: boolean, reason: string, details?: any }}
 */
const classifyStellarFailure = (error) => {
  if (!error) {
    return { isStellarFailure: false, reason: null };
  }

  const message = String(error?.message || error || '').toLowerCase();
  const codes = error?.response?.data?.extras?.result_codes || {};
  const opCodes = Array.isArray(codes.operations) ? codes.operations : [];
  const txCode = codes.transaction;

  // 1. Memo rejection / invalid memo
  if (
    /invalid.*memo/i.test(message) ||
    /unsupported memo/i.test(message) ||
    /memo.*too long/i.test(message) ||
    /conflicting/i.test(message) ||
    opCodes.includes('op_bad_memo') ||
    txCode === 'tx_bad_memo'
  ) {
    return {
      isStellarFailure: true,
      reason: STELLAR_ERROR_CODES.INVALID_MEMO,
      details: { message: error.message, opCodes, txCode },
    };
  }

  // 2. Missing or expired / non-existent trustline
  if (
    opCodes.includes('op_no_trust') ||
    opCodes.includes('op_src_no_trust') ||
    opCodes.includes('op_src_no_authorization') ||
    /no trustline/i.test(message) ||
    /missing trustline/i.test(message) ||
    /can't receive usdc/i.test(message) ||
    /expired trustline/i.test(message)
  ) {
    return {
      isStellarFailure: true,
      reason: STELLAR_ERROR_CODES.MISSING_OR_EXPIRED_TRUSTLINE,
      details: { message: error.message, opCodes, txCode },
    };
  }

  // 3. Underfunded / insufficient reserve
  if (
    opCodes.includes('op_underfunded') ||
    /op_underfunded/i.test(message) ||
    /insufficient.*balance/i.test(message) ||
    /insufficient xlm reserve/i.test(message)
  ) {
    return {
      isStellarFailure: true,
      reason: STELLAR_ERROR_CODES.OP_UNDERFUNDED,
      details: { message: error.message, opCodes, txCode },
    };
  }

  // 4. Line full
  if (opCodes.includes('op_line_full') || /op_line_full/i.test(message)) {
    return {
      isStellarFailure: true,
      reason: STELLAR_ERROR_CODES.OP_LINE_FULL,
      details: { message: error.message, opCodes, txCode },
    };
  }

  // 5. Destination account does not exist or is not funded
  if (
    opCodes.includes('op_no_destination') ||
    /destination.*not.*funded/i.test(message) ||
    /destination account does not exist/i.test(message)
  ) {
    return {
      isStellarFailure: true,
      reason: STELLAR_ERROR_CODES.OP_NO_DESTINATION,
      details: { message: error.message, opCodes, txCode },
    };
  }

  // 6. Generic Horizon transaction rejection
  if (
    txCode === 'tx_failed' ||
    txCode === 'tx_bad_seq' ||
    Boolean(error?.response?.data?.extras?.result_codes)
  ) {
    return {
      isStellarFailure: true,
      reason: txCode === 'tx_bad_seq' ? STELLAR_ERROR_CODES.TX_BAD_SEQ : STELLAR_ERROR_CODES.TX_FAILED,
      details: { message: error.message, opCodes, txCode },
    };
  }

  return {
    isStellarFailure: false,
    reason: null,
    details: { message: error?.message },
  };
};

/**
 * Triggers an immediate BullMQ reversal job when a Stellar failure occurs.
 *
 * @param {object} params
 * @param {string} params.transactionId
 * @param {string} params.reason
 * @param {object} [params.errorDetails]
 * @param {Function} [params.enqueueFn]
 * @returns {Promise<object>} The enqueued job result
 */
const triggerPaymentReversalJob = async ({
  transactionId,
  reason,
  errorDetails = {},
  enqueueFn = enqueue,
}) => {
  if (!transactionId) throw new Error('transactionId is required to trigger payment reversal');

  const jobData = {
    transactionId,
    reason,
    errorDetails,
    triggeredAt: new Date().toISOString(),
  };

  logger.info('triggering_payment_reversal_job', { transactionId, reason });

  return enqueueFn(QUEUE_NAME, JOB_NAME, jobData, {
    jobId: `reversal-${transactionId}`,
    priority: 1, // High priority matching payment submissions
    attempts: 3,
    backoff: { type: 'fixed', delay: 1000 },
  });
};

/**
 * Processes a reversal job: credits user balance via double-entry ledger & notifies user on WhatsApp.
 *
 * @param {object} job - BullMQ job object
 * @param {object} [deps] - Injected dependencies
 * @returns {Promise<{ success: boolean, transactionId: string, refundedAmount: string, asset: string }>}
 */
const processPaymentReversalJob = async (job, deps = {}) => {
  const prisma = deps.prisma || defaultPrisma();
  const sendNotification = deps.sendMessage || sendTextMessage;
  const { transactionId, reason, errorDetails } = job.data || {};

  if (!transactionId) {
    throw new Error('Reversal job missing transactionId');
  }

  const transaction = await prisma.transaction.findUnique({
    where: { id: transactionId },
    include: { user: true },
  });

  if (!transaction) {
    throw new Error(`Transaction ${transactionId} not found for reversal`);
  }

  // Idempotency check: if already reversed, don't double refund
  if (transaction.status === 'reversed') {
    logger.info('reversal_already_processed', { transactionId });
    return { success: true, alreadyProcessed: true, transactionId };
  }

  const refundCurrency = transaction.fiatCurrency || transaction.asset;
  const refundAmount = transaction.fiatAmount || transaction.amount;

  const nowIso = new Date().toISOString();

  // 1. Atomically record the refund and post ledger reversal
  const updatedTransaction = await (prisma.$transaction ? prisma.$transaction(async (tx) => {
    // Transition transaction to 'reversed' status
    const reversed = await transitionPaymentState({
      db: tx,
      transactionId: transaction.id,
      fromState: [transaction.status],
      toState: 'reversed',
      actor: { type: 'system', id: 'refund_engine' },
      reason: `Automated instant reversal: ${reason}`,
      metadata: {
        reversalReason: reason,
        reversedAt: nowIso,
        errorDetails,
        refund: {
          currency: refundCurrency,
          amount: refundAmount,
          refundedAt: nowIso,
        },
      },
    });

    // Credit user balance via ledger: reverses customer_money deduction
    await ledger.postPaymentFailed({ tx, transaction: reversed });

    return reversed;
  }) : (async () => {
    const reversed = await transitionPaymentState({
      db: prisma,
      transactionId: transaction.id,
      fromState: [transaction.status],
      toState: 'reversed',
      actor: { type: 'system', id: 'refund_engine' },
      reason: `Automated instant reversal: ${reason}`,
      metadata: {
        reversalReason: reason,
        reversedAt: nowIso,
        errorDetails,
        refund: {
          currency: refundCurrency,
          amount: refundAmount,
          refundedAt: nowIso,
        },
      },
    });
    await ledger.postPaymentFailed({ tx: prisma, transaction: reversed });
    return reversed;
  })());

  // 2. Notify user on WhatsApp
  const userPhone = transaction.user?.phoneNumber || transaction.recipientPhoneNumber;
  if (userPhone && typeof sendNotification === 'function') {
    try {
      const formattedAmount = `${refundAmount} ${refundCurrency}`;
      const messageBody =
        `Your payment of ${formattedAmount} could not be completed on Stellar (${reason.replace(/_/g, ' ')}). ` +
        `Your SendAm balance has been instantly credited with ${formattedAmount}.`;

      await sendNotification(userPhone, messageBody, {
        notification: {
          userId: transaction.userId,
          type: 'payment_reversal',
          referenceType: 'transaction',
          referenceId: transaction.id,
        },
      });
      logger.info('reversal_whatsapp_notification_sent', { transactionId, phoneNumber: userPhone });
    } catch (notifErr) {
      logger.error('reversal_whatsapp_notification_failed', {
        transactionId,
        error: notifErr.message,
      });
      // Do not re-throw notification failure to avoid re-crediting ledger in job retries
    }
  }

  logger.info('reversal_job_completed', {
    transactionId,
    refundAmount,
    refundCurrency,
    status: updatedTransaction.status,
  });

  return {
    success: true,
    transactionId,
    refundedAmount: refundAmount,
    currency: refundCurrency,
  };
};

/**
 * Handle Stellar payment rejection in the payment pipeline:
 * Catches Horizon rejection, triggers BullMQ reversal job, and transitions state.
 *
 * @param {object} params
 * @param {object} params.prisma
 * @param {object} params.transaction
 * @param {Error|object} params.error
 * @param {Function} [params.enqueueFn]
 * @returns {Promise<boolean>} true if handled as Stellar rejection, false otherwise
 */
const handleStellarPaymentFailure = async ({
  _prisma = defaultPrisma(),
  transaction,
  error,
  enqueueFn = enqueue,
}) => {
  const failure = classifyStellarFailure(error);

  if (!failure.isStellarFailure) {
    return false;
  }

  logger.warn('stellar_payment_rejection_detected', {
    transactionId: transaction.id,
    reason: failure.reason,
    error: error.message,
  });

  // Trigger instant reversal job in BullMQ
  try {
    await triggerPaymentReversalJob({
      transactionId: transaction.id,
      reason: failure.reason,
      errorDetails: failure.details,
      enqueueFn,
    });
    return true;
  } catch (enqueueErr) {
    logger.error('failed_to_enqueue_payment_reversal', {
      transactionId: transaction.id,
      error: enqueueErr.message,
    });
    return false;
  }
};

module.exports = {
  QUEUE_NAME,
  JOB_NAME,
  STELLAR_ERROR_CODES,
  classifyStellarFailure,
  triggerPaymentReversalJob,
  processPaymentReversalJob,
  handleStellarPaymentFailure,
};
