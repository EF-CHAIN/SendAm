const { test } = require('node:test');
const assert = require('node:assert/strict');

const { markTransactionFailed } = require('../src/payment/markFailed');

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
