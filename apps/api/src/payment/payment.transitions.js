'use strict';

const PAYMENT_STATUSES = [
  'processing',
  'pending',
  'success',
  'failed',
  'expired',
  'cancelled',
  'resolved',
  'escalated',
  'reversed',
];

// Matrix defining allowed state transitions.
// Keys are current status; values are allowed next statuses.
const PAYMENT_TRANSITIONS = {
  processing: ['pending', 'success', 'failed', 'cancelled', 'reversed'],
  pending:    ['success', 'failed', 'expired', 'escalated', 'resolved', 'cancelled', 'processing', 'reversed'],
  escalated:  ['processing', 'resolved', 'failed', 'success', 'reversed'],
  failed:     ['processing'],
  expired:    ['processing'],
  cancelled:  [], // Terminal state
  success:    ['reversed'], // Reversal
  resolved:   [], // Terminal state
  reversed:   [], // Terminal state
};

class PaymentTransitionError extends Error {
  constructor(code, message, details = {}, statusCode = 400) {
    super(message);
    this.name = 'PaymentTransitionError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

/**
 * Checks if a status transition is allowed by the matrix.
 */
function isValidPaymentTransition(fromStatus, toStatus) {
  if (!fromStatus) return true; // Initial creation
  if (fromStatus === toStatus) return true; // Idempotent same-state check
  const allowed = PAYMENT_TRANSITIONS[fromStatus];
  if (!allowed) return false;
  return allowed.includes(toStatus);
}

/**
 * Validates a transition request against allowlists and matrix.
 */
function validatePaymentTransition(currentStatus, targetStatus) {
  if (!PAYMENT_STATUSES.includes(targetStatus)) {
    throw new PaymentTransitionError(
      'INVALID_STATUS',
      `Invalid payment status "${targetStatus}". Allowed: ${PAYMENT_STATUSES.join(', ')}`,
      { currentStatus, targetStatus }
    );
  }
  if (!isValidPaymentTransition(currentStatus, targetStatus)) {
    throw new PaymentTransitionError(
      'INVALID_TRANSITION',
      `Cannot transition payment from "${currentStatus}" to "${targetStatus}". Allowed next states: ${
        (PAYMENT_TRANSITIONS[currentStatus] || []).join(', ') || 'none (terminal state)'
      }`,
      { currentStatus, targetStatus }
    );
  }
}

/**
 * Executes a Compare-And-Set (CAS) payment state transition transactionally.
 *
 * @param {object} params
 * @param {object} params.db Prisma client or transaction client
 * @param {string} params.transactionId ID of the transaction to transition
 * @param {string|string[]} [params.fromState] Expected current state(s). If null, fetched from DB.
 * @param {string} params.toState Target state
 * @param {object} [params.actor] Who/what caused transition { type: 'user'|'system'|'administrator', id: string }
 * @param {string} [params.reason] Human/system reason for transition
 * @param {object} [params.metadata] Additional metadata overrides
 * @param {object} [params.extraData] Additional fields on Transaction to update (e.g. txHash, explorerUrl)
 * @returns {Promise<object>} Updated transaction row
 */
async function transitionPaymentState({
  db,
  transactionId,
  fromState,
  toState,
  actor = { type: 'system', id: 'system' },
  action,
  reason = null,
  metadata = {},
  extraData = {},
}) {
  if (!db || !transactionId || !toState) {
    throw new PaymentTransitionError('INVALID_ARGUMENTS', 'db, transactionId, and toState are required.');
  }

  // 1. Verify target status is on the allowlist
  if (!PAYMENT_STATUSES.includes(toState)) {
    throw new PaymentTransitionError(
      'INVALID_STATUS',
      `Invalid payment status "${toState}". Allowed: ${PAYMENT_STATUSES.join(', ')}`,
      { transactionId, targetStatus: toState }
    );
  }

  // 2. Fetch current record if fromState is not explicitly specified or for state validation
  const current = await db.transaction.findUnique({ where: { id: transactionId } });
  if (!current) {
    throw new PaymentTransitionError('TRANSACTION_NOT_FOUND', `Transaction ${transactionId} not found.`, { transactionId }, 404);
  }

  const expectedFrom = fromState ?? current.status;
  const expectedFromList = Array.isArray(expectedFrom) ? expectedFrom : [expectedFrom];

  // Validate matrix rules for the current status
  validatePaymentTransition(current.status, toState);

  // If current status doesn't match expectedFromList
  if (!expectedFromList.includes(current.status)) {
    throw new PaymentTransitionError(
      'STALE_TRANSITION',
      `Stale transition: transaction ${transactionId} is currently in state "${current.status}", expected "${expectedFromList.join(' or ')}".`,
      { transactionId, currentStatus: current.status, expectedFrom },
      409
    );
  }

  // 3. Build state history entry
  const currentMeta = typeof current.metadata === 'object' && current.metadata !== null ? current.metadata : {};
  const stateHistory = Array.isArray(currentMeta.stateHistory) ? currentMeta.stateHistory : [];
  const historyRecord = {
    from: current.status,
    to: toState,
    actor,
    timestamp: new Date().toISOString(),
    ...(reason ? { reason } : {}),
  };

  const updatedMetadata = {
    ...currentMeta,
    ...metadata,
    stateHistory: [...stateHistory, historyRecord],
  };

  // 4. Compare-And-Set DB Update: enforce matching status in WHERE clause
  const casWhere = {
    id: transactionId,
    status: { in: expectedFromList },
  };

  let updateResult;
  if (typeof db.transaction.updateMany === 'function') {
    updateResult = await db.transaction.updateMany({
      where: casWhere,
      data: {
        status: toState,
        metadata: updatedMetadata,
        ...extraData,
      },
    });
  } else {
    const updated = await db.transaction.update({
      where: { id: transactionId },
      data: {
        status: toState,
        metadata: updatedMetadata,
        ...extraData,
      },
    });
    updateResult = { count: updated ? 1 : 0 };
  }

  if (updateResult.count === 0) {
    // CAS failed due to a concurrent write changing the status!
    const reFetched = await db.transaction.findUnique({ where: { id: transactionId } });
    throw new PaymentTransitionError(
      'CONCURRENCY_CONFLICT',
      `Compare-and-set failed for transaction ${transactionId}: state changed concurrently to "${reFetched?.status || 'unknown'}".`,
      { transactionId, previousStatus: current.status, actualStatus: reFetched?.status, targetStatus: toState },
      409
    );
  }

  // 5. Fetch updated row
  const updatedTx = await db.transaction.findUnique({ where: { id: transactionId } });

  // 6. Write audit log asynchronously
  try {
    const auditService = require('../common/audit.service');
    await auditService.writeAuditLog({
      actorType: actor.type || 'system',
      actorId: String(actor.id || 'system'),
      action: action || `payment.transition.${current.status}_to_${toState}`,
      entityType: 'Transaction',
      entityId: String(transactionId),
      metadata: { status: toState, fromState: current.status, toState, reason, ...metadata },
    });
  // eslint-disable-next-line no-empty
  } catch {}

  try {
    const eventService = require('../common/event.service');
    if (eventService.EVENT_TYPES?.PAYMENT_SUBMITTED) {
      await eventService.appendEvent({
        eventType: `payment.${toState}`,
        aggregateType: 'Transaction',
        aggregateId: String(transactionId),
        actorType: actor.type || 'system',
        actorId: String(actor.id || 'system'),
        payload: { fromState: current.status, toState, reason },
      });
    }
  // eslint-disable-next-line no-empty
  } catch {}

  return updatedTx;
}

module.exports = {
  PAYMENT_STATUSES,
  PAYMENT_TRANSITIONS,
  PaymentTransitionError,
  isValidPaymentTransition,
  validatePaymentTransition,
  transitionPaymentState,
};
