'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  QUEUE_NAME,
  JOB_NAME,
  STELLAR_ERROR_CODES,
  classifyStellarFailure,
  triggerPaymentReversalJob,
  processPaymentReversalJob,
  handleStellarPaymentFailure,
} = require('../src/payment/refundEngine');

test('classifyStellarFailure: identifies invalid memo rejections', () => {
  const err1 = new Error('Invalid text memo: maximum 28 bytes allowed.');
  const class1 = classifyStellarFailure(err1);
  assert.equal(class1.isStellarFailure, true);
  assert.equal(class1.reason, STELLAR_ERROR_CODES.INVALID_MEMO);

  const err2 = {
    message: 'Horizon rejection',
    response: { data: { extras: { result_codes: { operations: ['op_bad_memo'] } } } },
  };
  const class2 = classifyStellarFailure(err2);
  assert.equal(class2.isStellarFailure, true);
  assert.equal(class2.reason, STELLAR_ERROR_CODES.INVALID_MEMO);
});

test('classifyStellarFailure: identifies missing or expired trustline rejections', () => {
  const err1 = {
    message: 'Transaction failed',
    response: { data: { extras: { result_codes: { operations: ['op_no_trust'] } } } },
  };
  const class1 = classifyStellarFailure(err1);
  assert.equal(class1.isStellarFailure, true);
  assert.equal(class1.reason, STELLAR_ERROR_CODES.MISSING_OR_EXPIRED_TRUSTLINE);

  const err2 = new Error("The recipient can't receive USDC yet.");
  const class2 = classifyStellarFailure(err2);
  assert.equal(class2.isStellarFailure, true);
  assert.equal(class2.reason, STELLAR_ERROR_CODES.MISSING_OR_EXPIRED_TRUSTLINE);
});

test('classifyStellarFailure: identifies underfunded and insufficient balance errors', () => {
  const err = {
    message: 'op_underfunded',
    response: { data: { extras: { result_codes: { operations: ['op_underfunded'] } } } },
  };
  const res = classifyStellarFailure(err);
  assert.equal(res.isStellarFailure, true);
  assert.equal(res.reason, STELLAR_ERROR_CODES.OP_UNDERFUNDED);
});

test('classifyStellarFailure: returns false for unrelated application errors', () => {
  const err = new Error('Database connection timed out');
  const res = classifyStellarFailure(err);
  assert.equal(res.isStellarFailure, false);
  assert.equal(res.reason, null);
});

test('triggerPaymentReversalJob: queues reversal job with priority and metadata', async () => {
  const enqueuedJobs = [];
  const fakeEnqueue = async (queue, jobName, data, opts) => {
    enqueuedJobs.push({ queue, jobName, data, opts });
    return { id: opts.jobId };
  };

  const res = await triggerPaymentReversalJob({
    transactionId: 'tx_fail_123',
    reason: STELLAR_ERROR_CODES.INVALID_MEMO,
    errorDetails: { code: 'op_bad_memo' },
    enqueueFn: fakeEnqueue,
  });

  assert.equal(res.id, 'reversal-tx_fail_123');
  assert.equal(enqueuedJobs.length, 1);
  assert.equal(enqueuedJobs[0].queue, QUEUE_NAME);
  assert.equal(enqueuedJobs[0].jobName, JOB_NAME);
  assert.equal(enqueuedJobs[0].data.transactionId, 'tx_fail_123');
  assert.equal(enqueuedJobs[0].data.reason, STELLAR_ERROR_CODES.INVALID_MEMO);
  assert.equal(enqueuedJobs[0].opts.priority, 1);
});

const buildReversalPrisma = (mockTx, { existingReversal = null } = {}) => {
  const journalCreates = [];
  const mockPrisma = {
    transaction: {
      findUnique: async () => mockTx,
      update: async ({ data }) => {
        mockTx.status = data.status;
        mockTx.metadata = { ...mockTx.metadata, ...data.metadata };
        return mockTx;
      },
    },
    ledgerAccount: {
      findUnique: async () => ({ id: 'acc_1' }),
      create: async () => ({ id: 'acc_1' }),
    },
    journalEntry: {
      findFirst: async ({ where }) => (
        existingReversal && where.eventType === 'payment.failed_reversal' ? existingReversal : null
      ),
      create: async ({ data }) => {
        journalCreates.push(data);
        return { id: `entry_${journalCreates.length}`, ...data };
      },
    },
    ledgerPosting: {
      create: async () => ({ id: 'post_1' }),
    },
  };
  mockPrisma.$transaction = async (fn) => fn(mockPrisma);
  return { mockPrisma, journalCreates };
};

const failedTx = () => ({
  id: 'tx_fail_123',
  userId: 'user_456',
  status: 'failed',
  amount: '100.0000000',
  asset: 'USDC',
  fiatCurrency: 'NGN',
  fiatAmount: '150000.00',
  metadata: { fee: '1.0000000' },
  user: { phoneNumber: '+2348012345678' },
});

test('processPaymentReversalJob: does not credit again when the orchestrator already reversed the reservation', async () => {
  const mockTx = failedTx();
  const { mockPrisma, journalCreates } = buildReversalPrisma(mockTx, { existingReversal: { id: 'entry_orch' } });
  const sentMessages = [];
  const fakeSendMessage = async (phone, body, opts) => {
    sentMessages.push({ phone, body, opts });
    return { success: true };
  };

  const startTime = Date.now();
  const jobResult = await processPaymentReversalJob(
    { data: { transactionId: 'tx_fail_123', reason: STELLAR_ERROR_CODES.INVALID_MEMO } },
    { prisma: mockPrisma, sendMessage: fakeSendMessage },
  );
  const elapsedMs = Date.now() - startTime;

  // Acceptance Criteria: completes within 3 seconds
  assert.ok(elapsedMs < 3000, `Reversal took ${elapsedMs}ms, should be < 3000ms`);
  assert.equal(jobResult.success, true);
  assert.equal(jobResult.postedByJob, false);
  assert.equal(journalCreates.length, 0, 'must not post a second payment.failed_reversal');
  assert.equal(mockTx.status, 'reversed');

  // Notification states what was actually credited: amount + fee, in the payment asset.
  assert.equal(jobResult.refundedAmount, '101.0000000');
  assert.equal(jobResult.asset, 'USDC');
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].phone, '+2348012345678');
  assert.ok(sentMessages[0].body.includes('101.0000000 USDC'));
  assert.ok(!sentMessages[0].body.includes('NGN'));
});

test('processPaymentReversalJob: posts the reversal when the orchestrator could not', async () => {
  const mockTx = failedTx();
  const { mockPrisma, journalCreates } = buildReversalPrisma(mockTx);

  const jobResult = await processPaymentReversalJob(
    { data: { transactionId: 'tx_fail_123', reason: STELLAR_ERROR_CODES.MISSING_OR_EXPIRED_TRUSTLINE } },
    { prisma: mockPrisma, sendMessage: async () => ({ success: true }) },
  );

  assert.equal(jobResult.postedByJob, true);
  assert.equal(journalCreates.length, 1);
  assert.equal(journalCreates[0].eventType, 'payment.failed_reversal');
  assert.equal(mockTx.status, 'reversed');
});

test('processPaymentReversalJob: leaves a payment that is not failed untouched', async () => {
  const mockTx = { ...failedTx(), status: 'processing' };
  const { mockPrisma, journalCreates } = buildReversalPrisma(mockTx);
  const sentMessages = [];

  const jobResult = await processPaymentReversalJob(
    { data: { transactionId: 'tx_fail_123', reason: STELLAR_ERROR_CODES.TX_FAILED } },
    { prisma: mockPrisma, sendMessage: async (phone) => sentMessages.push(phone) },
  );

  assert.equal(jobResult.skipped, true);
  assert.equal(mockTx.status, 'processing');
  assert.equal(journalCreates.length, 0);
  assert.equal(sentMessages.length, 0);
});

test('classifyStellarFailure: does not treat unrelated "conflicting" errors as Stellar rejections', () => {
  const res = classifyStellarFailure(new Error('Unique constraint conflicting with existing row'));
  assert.equal(res.isStellarFailure, false);
});

test('processPaymentReversalJob: is idempotent and prevents double reversal', async () => {
  const mockTx = {
    id: 'tx_already_reversed',
    userId: 'user_456',
    status: 'reversed',
    amount: '50.0000000',
    asset: 'XLM',
    user: { phoneNumber: '+2348012345678' },
  };

  const mockPrisma = {
    transaction: {
      findUnique: async () => mockTx,
    },
  };

  const sentMessages = [];
  const fakeSendMessage = async (phone, body) => sentMessages.push({ phone, body });

  const jobResult = await processPaymentReversalJob(
    {
      data: {
        transactionId: 'tx_already_reversed',
        reason: STELLAR_ERROR_CODES.MISSING_OR_EXPIRED_TRUSTLINE,
      },
    },
    {
      prisma: mockPrisma,
      sendMessage: fakeSendMessage,
    }
  );

  assert.equal(jobResult.success, true);
  assert.equal(jobResult.alreadyProcessed, true);
  assert.equal(sentMessages.length, 0); // No double message or double ledger post
});

test('handleStellarPaymentFailure: catches Horizon rejection and enqueues reversal job', async () => {
  const enqueued = [];
  const fakeEnqueue = async (q, name, data, opts) => {
    enqueued.push({ q, name, data, opts });
    return { id: opts.jobId };
  };

  const stellarError = {
    message: 'Transaction submission rejected by Horizon',
    response: {
      data: {
        extras: {
          result_codes: {
            operations: ['op_no_trust'],
          },
        },
      },
    },
  };

  const handled = await handleStellarPaymentFailure({
    transaction: { id: 'tx_horizon_err' },
    error: stellarError,
    enqueueFn: fakeEnqueue,
  });

  assert.equal(handled, true);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].data.transactionId, 'tx_horizon_err');
  assert.equal(enqueued[0].data.reason, STELLAR_ERROR_CODES.MISSING_OR_EXPIRED_TRUSTLINE);
});
