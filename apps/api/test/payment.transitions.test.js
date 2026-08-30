const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  PAYMENT_STATUSES,
  PAYMENT_TRANSITIONS,
  PaymentTransitionError,
  isValidPaymentTransition,
  validatePaymentTransition,
  transitionPaymentState,
} = require('../src/payment/payment.transitions');

describe('Payment State Machine Matrix', () => {
  test('all payment statuses are defined in PAYMENT_STATUSES', () => {
    assert.ok(Array.isArray(PAYMENT_STATUSES));
    assert.ok(PAYMENT_STATUSES.includes('processing'));
    assert.ok(PAYMENT_STATUSES.includes('pending'));
    assert.ok(PAYMENT_STATUSES.includes('success'));
    assert.ok(PAYMENT_STATUSES.includes('failed'));
    assert.ok(PAYMENT_STATUSES.includes('expired'));
    assert.ok(PAYMENT_STATUSES.includes('cancelled'));
    assert.ok(PAYMENT_STATUSES.includes('resolved'));
    assert.ok(PAYMENT_STATUSES.includes('escalated'));
  });

  test('valid forward transitions for processing state', () => {
    assert.ok(isValidPaymentTransition('processing', 'pending'));
    assert.ok(isValidPaymentTransition('processing', 'success'));
    assert.ok(isValidPaymentTransition('processing', 'failed'));
    assert.ok(isValidPaymentTransition('processing', 'cancelled'));
  });

  test('valid forward transitions for pending state', () => {
    assert.ok(isValidPaymentTransition('pending', 'success'));
    assert.ok(isValidPaymentTransition('pending', 'failed'));
    assert.ok(isValidPaymentTransition('pending', 'expired'));
    assert.ok(isValidPaymentTransition('pending', 'escalated'));
    assert.ok(isValidPaymentTransition('pending', 'resolved'));
    assert.ok(isValidPaymentTransition('pending', 'cancelled'));
  });

  test('terminal states allow no outgoing transitions to other states', () => {
    assert.equal(isValidPaymentTransition('success', 'failed'), false);
    assert.equal(isValidPaymentTransition('success', 'processing'), false);
    assert.equal(isValidPaymentTransition('cancelled', 'success'), false);
    assert.equal(isValidPaymentTransition('resolved', 'processing'), false);
  });

  test('idempotent same-state check returns true', () => {
    assert.ok(isValidPaymentTransition('success', 'success'));
    assert.ok(isValidPaymentTransition('pending', 'pending'));
  });

  test('validatePaymentTransition throws for invalid target status', () => {
    assert.throws(
      () => validatePaymentTransition('processing', 'non_existent_status'),
      (err) => err instanceof PaymentTransitionError && err.code === 'INVALID_STATUS'
    );
  });

  test('validatePaymentTransition throws for disallowed transition', () => {
    assert.throws(
      () => validatePaymentTransition('success', 'failed'),
      (err) => err instanceof PaymentTransitionError && err.code === 'INVALID_TRANSITION'
    );
  });
});

describe('transitionPaymentState (Compare-And-Set & Actor Audit)', () => {
  const createMockDb = (initialTx) => {
    let currentRecord = { ...initialTx };
    return {
      get record() {
        return currentRecord;
      },
      transaction: {
        findUnique: async ({ where }) => {
          if (where.id === currentRecord.id) return { ...currentRecord };
          return null;
        },
        updateMany: async ({ where, data }) => {
          if (where.id !== currentRecord.id) return { count: 0 };
          const statusCond = where.status;
          let matches = false;
          if (typeof statusCond === 'string') {
            matches = currentRecord.status === statusCond;
          } else if (statusCond && Array.isArray(statusCond.in)) {
            matches = statusCond.in.includes(currentRecord.status);
          }
          if (!matches) return { count: 0 };

          currentRecord = {
            ...currentRecord,
            ...data,
            metadata: {
              ...(currentRecord.metadata || {}),
              ...(data.metadata || {}),
            },
          };
          return { count: 1 };
        },
      },
    };
  };

  test('successfully transitions state and records actor and stateHistory', async () => {
    const mockDb = createMockDb({
      id: 'tx_100',
      status: 'processing',
      metadata: {},
    });

    const result = await transitionPaymentState({
      db: mockDb,
      transactionId: 'tx_100',
      fromState: 'processing',
      toState: 'pending',
      actor: { type: 'user', id: 'user_42' },
      reason: 'Submitted to network',
      extraData: { txHash: '0x123' },
    });

    assert.equal(result.status, 'pending');
    assert.equal(result.txHash, '0x123');
    assert.ok(Array.isArray(result.metadata.stateHistory));
    assert.equal(result.metadata.stateHistory.length, 1);
    assert.equal(result.metadata.stateHistory[0].from, 'processing');
    assert.equal(result.metadata.stateHistory[0].to, 'pending');
    assert.equal(result.metadata.stateHistory[0].actor.type, 'user');
    assert.equal(result.metadata.stateHistory[0].actor.id, 'user_42');
    assert.equal(result.metadata.stateHistory[0].reason, 'Submitted to network');
  });

  test('throws STALE_TRANSITION error if current status does not match expected fromState', async () => {
    const mockDb = createMockDb({
      id: 'tx_101',
      status: 'success', // Already settled!
      metadata: {},
    });

    await assert.rejects(
      async () => {
        await transitionPaymentState({
          db: mockDb,
          transactionId: 'tx_101',
          fromState: 'pending',
          toState: 'failed',
          actor: { type: 'system', id: 'reconciler' },
        });
      },
      (err) => err instanceof PaymentTransitionError && (err.code === 'INVALID_TRANSITION' || err.code === 'STALE_TRANSITION')
    );
  });

  test('throws CONCURRENCY_CONFLICT if updateMany returns count: 0 (CAS race)', async () => {
    const mockDb = {
      transaction: {
        findUnique: async () => ({ id: 'tx_102', status: 'pending', metadata: {} }),
        updateMany: async () => ({ count: 0 }), // Simulate concurrent modification between findUnique & updateMany
      },
    };

    await assert.rejects(
      async () => {
        await transitionPaymentState({
          db: mockDb,
          transactionId: 'tx_102',
          fromState: 'pending',
          toState: 'success',
          actor: { type: 'system', id: 'reconciler' },
        });
      },
      (err) => err instanceof PaymentTransitionError && err.code === 'CONCURRENCY_CONFLICT'
    );
  });
});
