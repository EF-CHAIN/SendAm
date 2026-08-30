const { test } = require('node:test');
const assert = require('node:assert/strict');

const { markTransactionFailed, markTransactionCancelled, markTransactionReversed, normalizePaymentStatus } = require('../src/payment/markFailed');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

test('records the failed status with the original error message in metadata', async () => {
  const updates = [];
  const prisma = {
    transaction: {
      update: async (args) => {
        updates.push(args);
        return {};
      },
    },
  };

  await markTransactionFailed({
    prisma,
    transactionId: 'tx_1',
    metadata: { fee: '1.00' },
    error: new Error('tx_bad_seq'),
    logger: silentLogger,
  });

  assert.deepEqual(updates, [
    {
      where: { id: 'tx_1' },
      data: { status: 'failed', metadata: { fee: '1.00', error: 'tx_bad_seq' } },
    },
  ]);
});

test('swallows a rejecting update so the caller can rethrow the ORIGINAL error', async () => {
  const logged = [];
  const prisma = {
    transaction: {
      update: async () => {
        throw new Error('database is down');
      },
    },
  };

  // Must not throw — that is the whole point of the guard.
  await markTransactionFailed({
    prisma,
    transactionId: 'tx_1',
    metadata: {},
    error: new Error('payment failed'),
    logger: { ...silentLogger, error: (...args) => logged.push(args.join(' ')) },
  });

  assert.equal(logged.length, 1);
  assert.match(logged[0], /tx_1/);
  assert.match(logged[0], /database is down/);
});

test('normalizePaymentStatus maps successful payments to the public settled state', () => {
  assert.equal(normalizePaymentStatus('success'), 'settled');
  assert.equal(normalizePaymentStatus('failed'), 'failed');
  assert.equal(normalizePaymentStatus('cancelled'), 'cancelled');
  assert.equal(normalizePaymentStatus('reversed'), 'reversed');
  assert.equal(normalizePaymentStatus('pending'), 'pending');
});

test('markTransactionCancelled records a terminal cancelled state and cancellation metadata', async () => {
  const updates = [];
  const prisma = {
    transaction: {
      update: async (args) => {
        updates.push(args);
        return {};
      },
    },
  };

  await markTransactionCancelled({
    prisma,
    transactionId: 'tx_cancel',
    metadata: { fee: '1.00' },
    reason: 'customer_initiated',
    logger: silentLogger,
  });

  assert.deepEqual(updates, [{
    where: { id: 'tx_cancel' },
    data: {
      status: 'cancelled',
      metadata: {
        fee: '1.00',
        cancelledAt: updates[0].data.metadata.cancelledAt,
        cancellationReason: 'customer_initiated',
      },
    },
  }]);
  assert.ok(updates[0].data.metadata.cancelledAt);
});

test('markTransactionReversed records a terminal reversed state with compensation provenance', async () => {
  const updates = [];
  const prisma = {
    transaction: {
      update: async (args) => {
        updates.push(args);
        return {};
      },
    },
  };

  await markTransactionReversed({
    prisma,
    transactionId: 'tx_reverse',
    metadata: { fee: '1.00' },
    reason: 'timeout_reversal',
    logger: silentLogger,
  });

  assert.deepEqual(updates, [{
    where: { id: 'tx_reverse' },
    data: {
      status: 'reversed',
      metadata: {
        fee: '1.00',
        reversedAt: updates[0].data.metadata.reversedAt,
        reversalReason: 'timeout_reversal',
      },
    },
  }]);
  assert.ok(updates[0].data.metadata.reversedAt);
});
