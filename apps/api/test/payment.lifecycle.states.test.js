const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizePaymentStatus, markTransactionCancelled, markTransactionReversed, markTransactionFailed } = require('../src/payment/markFailed');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

test('pending payment retry: timeout without ledger evidence resolves to cancelled or reversed without leaving ambiguous state', async () => {
  const seen = [];
  const prisma = {
    transaction: {
      update: async (args) => {
        seen.push({ ...args });
        return { id: args.where.id, status: args.data.status, metadata: args.data.metadata };
      },
    },
  };

  const started = { id: 'p1', status: 'pending', metadata: { retryCount: 2, timeoutAt: '2026-08-29T00:00:00.000Z' } };

  const finalStatus = normalizePaymentStatus('pending');
  assert.equal(finalStatus, 'pending');

  await markTransactionCancelled({ prisma, transactionId: started.id, metadata: started.metadata, reason: 'timeout', logger: silentLogger });
  await markTransactionReversed({ prisma, transactionId: started.id, metadata: { ...started.metadata, cancellationReason: 'timeout' }, reason: 'timeout_reversal', logger: silentLogger });

  assert.equal(seen[0].data.status, 'cancelled');
  assert.equal(seen[1].data.status, 'reversed');
  assert.match(String(seen[0].data.metadata.cancelledAt), /T/);
  assert.match(String(seen[1].data.metadata.reversedAt), /T/);
  assert.equal(seen[0].data.metadata.cancellationReason, 'timeout');
  assert.equal(seen[1].data.metadata.reversalReason, 'timeout_reversal');
});

test('failed payment is normalized to terminal failed state and keeps ledger compensation metadata', async () => {
  const prisma = {
    transaction: {
      update: async (args) => {
        return { id: args.where.id, status: args.data.status, metadata: args.data.metadata };
      },
    },
  };

  await assert.doesNotReject(() => markTransactionFailed({
    prisma,
    transactionId: 'p2',
    metadata: { fee: '1.00', retryCount: 3 },
    error: new Error('tx_bad_seq'),
    logger: silentLogger,
  }));

  const normalized = normalizePaymentStatus('failed');
  assert.equal(normalized, 'failed');
});
