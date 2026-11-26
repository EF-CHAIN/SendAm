'use strict';

const defaultPrisma = () => require('../common/prisma');
const logger = require('../utils/logger');
const { validateMemo, isMuxedAddress } = require('../wallet/stellar.adapter');
const ledger = require('./ledger.service');
const { transitionPaymentState } = require('./payment.transitions');
const { enqueue } = require('../queues/queue.service');

const MEMO_EXCEPTION_QUEUE = 'memo-exceptions';
const MEMO_EXCEPTION_JOB = 'memo.exception_reconcile';

const knownDestinationMemoPolicies = new Map();

const setDestinationMemoPolicy = (address, policy) => {
  if (!address) return;
  knownDestinationMemoPolicies.set(String(address).trim(), policy);
};

const getDestinationMemoPolicy = (address) => {
  if (!address) return null;
  return knownDestinationMemoPolicies.get(String(address).trim()) || null;
};

const validateDestinationMemo = ({ destination, memo, memoType = 'text', policy }) => {
  const dest = String(destination || '').trim();
  const effectivePolicy = policy || getDestinationMemoPolicy(dest) || {};

  const isMuxed = isMuxedAddress(dest);
  if (isMuxed && memo !== undefined && memo !== null && memo !== '') {
    return {
      isValid: false,
      reason: 'conflicting_muxed_memo',
      message: 'Muxed destination account embeds an ID; separate memo is not permitted.',
    };
  }

  const memoRequired = Boolean(effectivePolicy.required || effectivePolicy.memoRequired);
  const hasMemo = memo !== undefined && memo !== null && String(memo).trim() !== '';

  if (memoRequired && !hasMemo) {
    return {
      isValid: false,
      reason: 'missing_required_memo',
      message: `Destination account ${dest} requires a transaction memo.`,
    };
  }

  if (hasMemo) {
    const requiredType = effectivePolicy.expectedType || effectivePolicy.memoType;
    if (requiredType && String(memoType).toLowerCase() !== String(requiredType).toLowerCase()) {
      return {
        isValid: false,
        reason: 'invalid_memo_type',
        message: `Expected memo of type "${requiredType}" but received "${memoType}".`,
      };
    }

    try {
      validateMemo({ memo, memoType });
    } catch (err) {
      return {
        isValid: false,
        reason: 'malformed_memo',
        message: err.message,
      };
    }

    if (effectivePolicy.pattern) {
      const regex = typeof effectivePolicy.pattern === 'string' ? new RegExp(effectivePolicy.pattern) : effectivePolicy.pattern;
      if (!regex.test(String(memo).trim())) {
        return {
          isValid: false,
          reason: 'memo_format_mismatch',
          message: `Memo does not match expected pattern ${regex}`,
        };
      }
    }
  }

  return { isValid: true, reason: null };
};

const verifyDepositMemo = async ({
  destination,
  memo,
  memoType = 'text',
  expectedReference,
  prisma = defaultPrisma(),
}) => {
  const memoValidation = validateDestinationMemo({ destination, memo, memoType });
  if (!memoValidation.isValid) {
    return {
      matched: false,
      reason: memoValidation.reason,
      message: memoValidation.message,
      user: null,
      transaction: null,
    };
  }

  const memoStr = memo !== undefined && memo !== null ? String(memo).trim() : null;

  if (expectedReference) {
    const matched = memoStr === String(expectedReference).trim();
    return {
      matched,
      reason: matched ? null : 'reference_mismatch',
      message: matched ? null : `Incoming memo "${memoStr}" does not match expected "${expectedReference}".`,
      user: null,
      transaction: null,
    };
  }

  if (!memoStr) {
    return {
      matched: true,
      reason: null,
      user: null,
      transaction: null,
    };
  }

  if (prisma?.transaction?.findFirst) {
    const matchedTx = await prisma.transaction.findFirst({
      where: {
        OR: [
          { id: memoStr },
          { idempotencyKey: memoStr },
        ],
      },
      include: { user: true },
    });

    if (matchedTx) {
      return {
        matched: true,
        reason: null,
        user: matchedTx.user,
        transaction: matchedTx,
      };
    }
  }

  if (prisma?.user?.findFirst) {
    const matchedUser = await prisma.user.findFirst({
      where: {
        OR: [
          { id: memoStr },
          { phoneNumber: memoStr },
        ],
      },
    });

    if (matchedUser) {
      return {
        matched: true,
        reason: null,
        user: matchedUser,
        transaction: null,
      };
    }
  }

  const policy = getDestinationMemoPolicy(destination);
  if (policy?.required || policy?.memoRequired) {
    return {
      matched: false,
      reason: 'unmatched_deposit_reference',
      message: `Incoming memo "${memoStr}" could not be matched to an active user or transaction reference.`,
      user: null,
      transaction: null,
    };
  }

  return {
    matched: true,
    reason: null,
    user: null,
    transaction: null,
  };
};

const routeToExceptionQueue = async ({
  depositData,
  reason,
  details = {},
  prisma = defaultPrisma(),
  enqueueFn = enqueue,
}) => {
  const {
    stellarPaymentId,
    transactionId,
    destination,
    amount,
    asset,
    memo,
    memoType,
    txHash,
  } = depositData;

  const checkpointId = `chk_memo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  let checkpoint = null;

  if (prisma?.reconciliationCheckpoint?.create) {
    try {
      checkpoint = await prisma.reconciliationCheckpoint.create({
        data: {
          id: checkpointId,
          transactionId: transactionId || stellarPaymentId || txHash || `unmatched_${Date.now()}`,
          checkpointType: 'memo_exception',
          status: 'mismatch',
          mismatchDetails: {
            reason,
            destination,
            amount: String(amount || ''),
            asset: asset || 'XLM',
            memo: memo ? String(memo) : null,
            memoType: memoType || 'text',
            txHash: txHash || null,
            ...details,
            reportedAt: new Date().toISOString(),
          },
          evidence: {
            depositData,
          },
        },
      });
    } catch (dbErr) {
      logger.warn('memo_reconciliation_checkpoint_create_failed', { error: dbErr.message });
    }
  }

  let queueJob = null;
  try {
    queueJob = await enqueueFn(MEMO_EXCEPTION_QUEUE, MEMO_EXCEPTION_JOB, {
      checkpointId: checkpoint?.id || checkpointId,
      depositData,
      reason,
      details,
    }, {
      jobId: `memo-exception-${stellarPaymentId || txHash || checkpointId}`,
      priority: 2,
      attempts: 3,
    });
  } catch (qErr) {
    logger.warn('memo_exception_queue_enqueue_failed', { error: qErr.message });
  }

  logger.info('routed_to_memo_exception_queue', {
    destination,
    reason,
    checkpointId: checkpoint?.id || checkpointId,
  });

  return {
    routed: true,
    checkpointId: checkpoint?.id || checkpointId,
    jobId: queueJob?.id || null,
    status: 'routed_to_exception_dashboard',
  };
};

const reconcileIncomingDeposit = async ({
  depositData,
  expectedReference,
  prisma = defaultPrisma(),
  enqueueFn = enqueue,
}) => {
  const {
    destination,
    amount,
    asset,
    memo,
    memoType = 'text',
    transactionId,
  } = depositData;

  const matchResult = await verifyDepositMemo({
    destination,
    memo,
    memoType,
    expectedReference,
    prisma,
  });

  if (!matchResult.matched) {
    const routingResult = await routeToExceptionQueue({
      depositData,
      reason: matchResult.reason,
      details: { message: matchResult.message },
      prisma,
      enqueueFn,
    });

    return {
      status: 'exception',
      credited: false,
      reason: matchResult.reason,
      message: matchResult.message,
      exceptionRecord: routingResult,
    };
  }

  const userId = matchResult.user?.id || matchResult.transaction?.userId || depositData.userId;

  let updatedTransaction = null;
  if (transactionId && prisma?.transaction?.findUnique) {
    const existing = await prisma.transaction.findUnique({ where: { id: transactionId } });
    if (existing && existing.status !== 'success') {
      updatedTransaction = await transitionPaymentState({
        db: prisma,
        transactionId,
        fromState: [existing.status],
        toState: 'success',
        actor: { type: 'system', id: 'memo_reconciler' },
        reason: 'Deposit memo successfully verified and reconciled',
        metadata: {
          memoVerified: true,
          verifiedMemo: memo,
          verifiedAt: new Date().toISOString(),
        },
      });
    }
  }

  if (userId && prisma) {
    await ledger.createJournalEntry({
      tx: prisma,
      eventType: 'deposit.credited',
      transactionId: transactionId || null,
      externalRef: depositData.txHash || depositData.stellarPaymentId,
      metadata: { memo, destination },
      postings: [
        { type: 'stellar_settled', asset: asset || 'XLM', amount: `-${amount}` },
        { type: 'customer_money', userId, asset: asset || 'XLM', amount: String(amount) },
      ],
    }).catch((err) => {
      logger.warn('deposit_ledger_posting_failed', { error: err.message });
    });
  }

  logger.info('deposit_memo_verified_and_credited', {
    destination,
    amount,
    asset,
    userId,
    transactionId,
  });

  return {
    status: 'credited',
    credited: true,
    userId,
    transaction: updatedTransaction,
  };
};

const resolveExceptionDeposit = async ({
  checkpointId,
  targetUserId,
  adminId,
  resolutionReason,
  prisma = defaultPrisma(),
}) => {
  if (!checkpointId) throw new Error('checkpointId is required.');
  if (!targetUserId) throw new Error('targetUserId is required to credit deposit.');

  const checkpoint = await prisma.reconciliationCheckpoint.findUnique({
    where: { id: checkpointId },
  });

  if (!checkpoint) throw new Error(`Checkpoint ${checkpointId} not found.`);
  if (checkpoint.status === 'success' || checkpoint.status === 'resolved') {
    return { alreadyResolved: true, checkpoint };
  }

  const mismatch = checkpoint.mismatchDetails || {};
  const evidence = checkpoint.evidence || {};
  const depositData = evidence.depositData || mismatch;

  const user = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!user) throw new Error(`Target user ${targetUserId} not found.`);

  const amount = depositData.amount;
  const asset = depositData.asset || 'XLM';

  const resolved = await (prisma.$transaction ? prisma.$transaction(async (tx) => {
    const updated = await tx.reconciliationCheckpoint.update({
      where: { id: checkpointId },
      data: {
        status: 'success',
        resolvedBy: adminId,
        resolvedAt: new Date(),
        mismatchDetails: {
          ...mismatch,
          resolution: 'manually_credited_by_admin',
          reason: resolutionReason,
          targetUserId,
          resolvedAt: new Date().toISOString(),
        },
      },
    });

    await ledger.createJournalEntry({
      tx,
      eventType: 'deposit.reconciled_credit',
      transactionId: checkpoint.transactionId,
      metadata: { checkpointId, adminId, reason: resolutionReason },
      postings: [
        { type: 'stellar_settled', asset, amount: `-${amount}` },
        { type: 'customer_money', userId: targetUserId, asset, amount: String(amount) },
      ],
    });

    return updated;
  }) : (async () => {
    const updated = await prisma.reconciliationCheckpoint.update({
      where: { id: checkpointId },
      data: {
        status: 'success',
        resolvedBy: adminId,
        resolvedAt: new Date(),
      },
    });
    await ledger.createJournalEntry({
      tx: prisma,
      eventType: 'deposit.reconciled_credit',
      transactionId: checkpoint.transactionId,
      metadata: { checkpointId, adminId, reason: resolutionReason },
      postings: [
        { type: 'stellar_settled', asset, amount: `-${amount}` },
        { type: 'customer_money', userId: targetUserId, asset, amount: String(amount) },
      ],
    });
    return updated;
  })());

  return {
    success: true,
    credited: true,
    targetUserId,
    checkpoint: resolved,
  };
};

module.exports = {
  MEMO_EXCEPTION_QUEUE,
  MEMO_EXCEPTION_JOB,
  setDestinationMemoPolicy,
  getDestinationMemoPolicy,
  validateDestinationMemo,
  verifyDepositMemo,
  routeToExceptionQueue,
  reconcileIncomingDeposit,
  resolveExceptionDeposit,
};
