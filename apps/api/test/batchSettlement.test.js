'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { StellarSdk } = require('../src/config/stellar');

const {
  QUEUE_NAME,
  JOB_NAME,
  validateBatchTransfers,
  buildBatchPaymentTransaction,
  executeBatchSettlement,
  enqueueBatchSettlement,
  processBatchSettlementJob,
} = require('../src/payment/batchSettlement');

test('validateBatchTransfers: validates transfers and normalizes amounts', () => {
  const validKey = StellarSdk.Keypair.random().publicKey();
  const input = [
    { destination: validKey, amount: '10.5', asset: 'XLM', recipientId: 'r1' },
    { destination: validKey, amount: '5', asset: 'USDC', id: 'tx_custom_id' },
  ];

  const validated = validateBatchTransfers(input);
  assert.equal(validated.length, 2);
  assert.equal(validated[0].amount, '10.5000000');
  assert.equal(validated[0].asset, 'XLM');
  assert.equal(validated[0].recipientId, 'r1');
  assert.equal(validated[1].amount, '5.0000000');
  assert.equal(validated[1].asset, 'USDC');
  assert.equal(validated[1].id, 'tx_custom_id');
});

test('validateBatchTransfers: throws on empty transfers or exceeding max 100 operations', () => {
  assert.throws(() => validateBatchTransfers([]), /at least 1 transfer/);

  const validKey = StellarSdk.Keypair.random().publicKey();
  const tooMany = Array.from({ length: 101 }, (_, i) => ({
    destination: validKey,
    amount: '1',
    asset: 'XLM',
    id: `tx_${i}`,
  }));

  assert.throws(() => validateBatchTransfers(tooMany), /exceeds maximum of 100 operations/);
});

test('validateBatchTransfers: throws on invalid destination address', () => {
  assert.throws(
    () => validateBatchTransfers([{ destination: 'invalid-stellar-address', amount: '1', asset: 'XLM' }]),
    /invalid Stellar destination address/
  );
});

test('buildBatchPaymentTransaction: bundles up to 100 payment operations with scaled fee', () => {
  const sourceKeypair = StellarSdk.Keypair.random();
  const sourceAccount = new StellarSdk.Account(sourceKeypair.publicKey(), '100');

  const destKeypair1 = StellarSdk.Keypair.random();
  const destKeypair2 = StellarSdk.Keypair.random();

  const transfers = [
    { destination: destKeypair1.publicKey(), amount: '15.0000000', asset: 'XLM' },
    { destination: destKeypair2.publicKey(), amount: '25.0000000', asset: 'XLM' },
  ];

  const tx = buildBatchPaymentTransaction({
    sourceAccount,
    transfers,
    baseFee: 150,
    memo: 'dinner-split',
    memoType: 'text',
  });

  assert.equal(tx.operations.length, 2);
  assert.equal(Number(tx.fee), 300);
  assert.equal(tx.memo.value, 'dinner-split');
});

test('executeBatchSettlement: builds, signs, submits transaction and updates database records', async () => {
  const sourceKeypair = StellarSdk.Keypair.random();
  const destKeypair1 = StellarSdk.Keypair.random();
  const destKeypair2 = StellarSdk.Keypair.random();

  const mockServer = {
    fetchBaseFee: async () => 100,
    loadAccount: async (publicKey) => new StellarSdk.Account(publicKey, '500'),
    submitTransaction: async (tx) => {
      assert.equal(tx.operations.length, 2);
      return {
        hash: 'mock_tx_hash_batch_123',
        ledger: 123456,
      };
    },
  };

  const dbUpdates = [];
  const mockPrisma = {
    transaction: {
      findUnique: async ({ where }) => ({ id: where.id, status: 'processing' }),
      update: async ({ where, data }) => {
        dbUpdates.push({ id: where.id, status: data.status });
        return { id: where.id, ...data };
      },
    },
    $transaction: async (fn) => fn(mockPrisma),
  };

  const transfers = [
    { id: 'tx_recip_1', destination: destKeypair1.publicKey(), amount: '10.0000000', asset: 'XLM' },
    { id: 'tx_recip_2', destination: destKeypair2.publicKey(), amount: '20.0000000', asset: 'XLM' },
  ];

  const startTime = Date.now();
  const result = await executeBatchSettlement({
    secretKey: sourceKeypair.secret(),
    transfers,
    horizonServer: mockServer,
    prisma: mockPrisma,
  });
  const elapsedMs = Date.now() - startTime;

  assert.ok(elapsedMs < 5000, `Batch settlement took ${elapsedMs}ms, expected under 5000ms`);
  assert.equal(result.success, true);
  assert.equal(result.txHash, 'mock_tx_hash_batch_123');
  assert.equal(result.recipientCount, 2);
  assert.equal(result.ledger, 123456);
  assert.equal(result.totals.XLM, '30.0000000');
  assert.equal(dbUpdates.length, 2);
  assert.equal(dbUpdates[0].status, 'success');
  assert.equal(dbUpdates[1].status, 'success');
});

test('enqueueBatchSettlement and processBatchSettlementJob: queues and executes job', async () => {
  const enqueued = [];
  const fakeEnqueue = async (queue, jobName, data, opts) => {
    enqueued.push({ queue, jobName, data, opts });
    return { id: opts.jobId };
  };

  const sourceKeypair = StellarSdk.Keypair.random();
  const destKeypair = StellarSdk.Keypair.random();
  const transfers = [
    { destination: destKeypair.publicKey(), amount: '5.0000000', asset: 'XLM' },
  ];

  const enqueuedResult = await enqueueBatchSettlement({
    batchId: 'batch_test_789',
    secretKey: sourceKeypair.secret(),
    transfers,
    memo: 'payroll',
    enqueueFn: fakeEnqueue,
  });

  assert.equal(enqueuedResult.id, 'batch_test_789');
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].queue, QUEUE_NAME);
  assert.equal(enqueued[0].jobName, JOB_NAME);
  assert.equal(enqueued[0].data.batchId, 'batch_test_789');

  const mockServer = {
    fetchBaseFee: async () => 100,
    loadAccount: async (publicKey) => new StellarSdk.Account(publicKey, '500'),
    submitTransaction: async () => ({ hash: 'tx_batch_done', ledger: 999 }),
  };

  const jobResult = await processBatchSettlementJob(
    { data: enqueued[0].data },
    { horizonServer: mockServer }
  );

  assert.equal(jobResult.success, true);
  assert.equal(jobResult.txHash, 'tx_batch_done');
});
