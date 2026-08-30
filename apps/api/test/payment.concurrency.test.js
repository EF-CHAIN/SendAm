const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  transitionPaymentState,
  PaymentTransitionError,
} = require('../src/payment/payment.transitions');

describe('Payment State Transition Concurrency Races', () => {
  // Simulates a PostgreSQL table with row-level atomic compare-and-set locking
  const createConcurrentDb = (initialRecord) => {
    let state = { ...initialRecord };
    let lock = Promise.resolve();

    return {
      get state() {
        return state;
      },
      transaction: {
        findUnique: async ({ where }) => {
          if (where.id === state.id) return { ...state };
          return null;
        },
        updateMany: async ({ where, data }) => {
          // Use atomic lock turn to simulate single DB transaction execution order
          return new Promise((resolve) => {
            lock = lock.then(async () => {
              if (where.id !== state.id) {
                resolve({ count: 0 });
                return;
              }

              let statusMatches = false;
              if (typeof where.status === 'string') {
                statusMatches = state.status === where.status;
              } else if (where.status && Array.isArray(where.status.in)) {
                statusMatches = where.status.in.includes(state.status);
              }

              if (!statusMatches) {
                resolve({ count: 0 });
                return;
              }

              state = {
                ...state,
                ...data,
                metadata: {
                  ...(state.metadata || {}),
                  ...(data.metadata || {}),
                },
              };
              resolve({ count: 1 });
            });
          });
        },
      },
    };
  };

  test('confirm vs cancel race condition', async () => {
    const db = createConcurrentDb({
      id: 'tx_race_1',
      status: 'pending',
      metadata: {},
    });

    const confirmOp = transitionPaymentState({
      db,
      transactionId: 'tx_race_1',
      fromState: 'pending',
      toState: 'success',
      actor: { type: 'system', id: 'reconciler' },
      reason: 'Ledger confirmed',
    });

    const cancelOp = transitionPaymentState({
      db,
      transactionId: 'tx_race_1',
      fromState: 'pending',
      toState: 'cancelled',
      actor: { type: 'user', id: 'user_1' },
      reason: 'User cancelled',
    });

    const results = await Promise.allSettled([confirmOp, cancelOp]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'Exactly one transition must succeed');
    assert.equal(rejected.length, 1, 'Competing transition must be rejected');
    assert.ok(
      rejected[0].reason instanceof PaymentTransitionError,
      'Rejection must be a PaymentTransitionError'
    );
    assert.ok(
      ['success', 'cancelled'].includes(db.state.status),
      'Final status must be one of the winning states'
    );
  });

  test('confirm vs fail race condition', async () => {
    const db = createConcurrentDb({
      id: 'tx_race_2',
      status: 'pending',
      metadata: {},
    });

    const confirmOp = transitionPaymentState({
      db,
      transactionId: 'tx_race_2',
      fromState: 'pending',
      toState: 'success',
      actor: { type: 'system', id: 'reconciler' },
      reason: 'Horizon confirmed',
    });

    const failOp = transitionPaymentState({
      db,
      transactionId: 'tx_race_2',
      fromState: 'pending',
      toState: 'failed',
      actor: { type: 'system', id: 'orchestrator' },
      reason: 'Network timeout',
    });

    const results = await Promise.allSettled([confirmOp, failOp]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(
      ['success', 'failed'].includes(db.state.status)
    );
  });

  test('reconcile race condition (dual reconciler execution)', async () => {
    const db = createConcurrentDb({
      id: 'tx_race_3',
      status: 'pending',
      metadata: {},
    });

    const reconcilerWorker1 = transitionPaymentState({
      db,
      transactionId: 'tx_race_3',
      fromState: ['processing', 'pending'],
      toState: 'success',
      actor: { type: 'system', id: 'reconciler_worker_1' },
      reason: 'Reconciler 1 confirmed on-chain',
    });

    const reconcilerWorker2 = transitionPaymentState({
      db,
      transactionId: 'tx_race_3',
      fromState: ['processing', 'pending'],
      toState: 'success',
      actor: { type: 'system', id: 'reconciler_worker_2' },
      reason: 'Reconciler 2 confirmed on-chain',
    });

    const results = await Promise.allSettled([reconcilerWorker1, reconcilerWorker2]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'Only one reconciler worker can transition state');
    assert.equal(rejected.length, 1, 'Second reconciler worker is blocked by CAS check');
    assert.equal(db.state.status, 'success');
  });

  test('cancel vs reconcile race condition', async () => {
    const db = createConcurrentDb({
      id: 'tx_race_4',
      status: 'pending',
      metadata: {},
    });

    const userCancel = transitionPaymentState({
      db,
      transactionId: 'tx_race_4',
      fromState: 'pending',
      toState: 'cancelled',
      actor: { type: 'user', id: 'user_99' },
      reason: 'User click cancel',
    });

    const reconcileExpire = transitionPaymentState({
      db,
      transactionId: 'tx_race_4',
      fromState: ['processing', 'pending'],
      toState: 'expired',
      actor: { type: 'system', id: 'reconciler' },
      reason: 'Ledger sequence window expired',
    });

    const results = await Promise.allSettled([userCancel, reconcileExpire]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(
      ['cancelled', 'expired'].includes(db.state.status)
    );
  });
});
