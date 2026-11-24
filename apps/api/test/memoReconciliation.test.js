'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { StellarSdk } = require('../src/config/stellar');

const {
  setDestinationMemoPolicy,
  getDestinationMemoPolicy,
  validateDestinationMemo,
  verifyDepositMemo,
  routeToExceptionQueue,
  reconcileIncomingDeposit,
  resolveExceptionDeposit,
  MEMO_EXCEPTION_QUEUE,
  MEMO_EXCEPTION_JOB,
} = require('../src/payment/memoReconciliation');

test('setDestinationMemoPolicy and getDestinationMemoPolicy: manages destination memo rules', () => {
  const omnibusAddress = StellarSdk.Keypair.random().publicKey();
  setDestinationMemoPolicy(omnibusAddress, {
    required: true,
    expectedType: 'id',
    pattern: '^\\d{6,12}$',
  });

  const policy = getDestinationMemoPolicy(omnibusAddress);
  assert.equal(policy.required, true);
  assert.equal(policy.expectedType, 'id');
  assert.equal(policy.pattern, '^\\d{6,12}$');
});

test('validateDestinationMemo: enforces requirements and validates formats', () => {
  const destKey = StellarSdk.Keypair.random().publicKey();
  setDestinationMemoPolicy(destKey, {
    required: true,
    expectedType: 'text',
    pattern: '^USER_[A-Z0-9]+$',
  });

  const missingRes = validateDestinationMemo({ destination: destKey, memo: '' });
  assert.equal(missingRes.isValid, false);
  assert.equal(missingRes.reason, 'missing_required_memo');

  const wrongTypeRes = validateDestinationMemo({
    destination: destKey,
    memo: 'USER_123',
    memoType: 'hash',
  });
  assert.equal(wrongTypeRes.isValid, false);
  assert.equal(wrongTypeRes.reason, 'invalid_memo_type');

  const patternFailRes = validateDestinationMemo({
    destination: destKey,
    memo: 'invalid_format',
    memoType: 'text',
  });
  assert.equal(patternFailRes.isValid, false);
  assert.equal(patternFailRes.reason, 'memo_format_mismatch');

  const validRes = validateDestinationMemo({
    destination: destKey,
    memo: 'USER_ABC123',
    memoType: 'text',
  });
  assert.equal(validRes.isValid, true);
});

test('verifyDepositMemo: matches expectedReference or user/transaction lookup', async () => {
  const destKey = StellarSdk.Keypair.random().publicKey();

  const refMatch = await verifyDepositMemo({
    destination: destKey,
    memo: 'ORDER_999',
    expectedReference: 'ORDER_999',
  });
  assert.equal(refMatch.matched, true);

  const refMismatch = await verifyDepositMemo({
    destination: destKey,
    memo: 'WRONG_REF',
    expectedReference: 'ORDER_999',
  });
  assert.equal(refMismatch.matched, false);
  assert.equal(refMismatch.reason, 'reference_mismatch');

  const mockPrisma = {
    transaction: {
      findFirst: async ({ where }) => {
        if (where.OR?.[0]?.id === 'tx_known_123') {
          return { id: 'tx_known_123', userId: 'user_real_456', user: { id: 'user_real_456' } };
        }
        return null;
      },
    },
    user: {
      findFirst: async () => null,
    },
  };

  const dbMatch = await verifyDepositMemo({
    destination: destKey,
    memo: 'tx_known_123',
    prisma: mockPrisma,
  });
  assert.equal(dbMatch.matched, true);
  assert.equal(dbMatch.user?.id, 'user_real_456');
  assert.equal(dbMatch.transaction?.id, 'tx_known_123');
});

test('routeToExceptionQueue: logs exception checkpoint and enqueues to exception queue', async () => {
  const checkpoints = [];
  const mockPrisma = {
    reconciliationCheckpoint: {
      create: async ({ data }) => {
        checkpoints.push(data);
        return { ...data };
      },
    },
  };

  const enqueued = [];
  const fakeEnqueue = async (queue, jobName, data, opts) => {
    enqueued.push({ queue, jobName, data, opts });
    return { id: opts.jobId };
  };

  const depositData = {
    stellarPaymentId: 'pay_999',
    destination: 'GABC_EXCHANGE',
    amount: '150.0000000',
    asset: 'XLM',
    memo: null,
  };

  const res = await routeToExceptionQueue({
    depositData,
    reason: 'missing_required_memo',
    prisma: mockPrisma,
    enqueueFn: fakeEnqueue,
  });

  assert.equal(res.routed, true);
  assert.equal(res.status, 'routed_to_exception_dashboard');
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].checkpointType, 'memo_exception');
  assert.equal(checkpoints[0].status, 'mismatch');
  assert.equal(checkpoints[0].mismatchDetails.reason, 'missing_required_memo');
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].queue, MEMO_EXCEPTION_QUEUE);
  assert.equal(enqueued[0].jobName, MEMO_EXCEPTION_JOB);
});

test('reconcileIncomingDeposit: credits valid deposit immediately and routes invalid memo to dashboard queue', async () => {
  const ledgerEntries = [];
  const mockPrisma = {
    transaction: {
      findFirst: async () => null,
      findUnique: async () => null,
    },
    user: {
      findFirst: async ({ where }) => {
        if (where.OR?.[0]?.phoneNumber === '+2348011112222' || where.OR?.[1]?.phoneNumber === '+2348011112222') {
          return { id: 'user_dest_1' };
        }
        return null;
      },
    },
    reconciliationCheckpoint: {
      create: async ({ data }) => ({ ...data }),
    },
    ledgerAccount: {
      findUnique: async () => ({ id: 'acc_1' }),
      create: async () => ({ id: 'acc_1' }),
    },
    journalEntry: {
      create: async ({ data }) => {
        ledgerEntries.push(data);
        return { id: 'entry_1', ...data };
      },
    },
    ledgerPosting: {
      create: async () => ({ id: 'post_1' }),
    },
  };

  const validDeposit = {
    stellarPaymentId: 'pay_valid_1',
    destination: 'G_WALLET_NORMAL',
    amount: '50.0000000',
    asset: 'XLM',
    memo: '+2348011112222',
    memoType: 'text',
  };

  const validRes = await reconcileIncomingDeposit({
    depositData: validDeposit,
    prisma: mockPrisma,
  });

  assert.equal(validRes.status, 'credited');
  assert.equal(validRes.credited, true);
  assert.equal(validRes.userId, 'user_dest_1');
  assert.equal(ledgerEntries.length, 1);
  assert.equal(ledgerEntries[0].eventType, 'deposit.credited');

  const exchangeDest = StellarSdk.Keypair.random().publicKey();
  setDestinationMemoPolicy(exchangeDest, { required: true });

  const invalidDeposit = {
    stellarPaymentId: 'pay_invalid_1',
    destination: exchangeDest,
    amount: '100.0000000',
    asset: 'XLM',
    memo: '',
  };

  const invalidRes = await reconcileIncomingDeposit({
    depositData: invalidDeposit,
    prisma: mockPrisma,
    enqueueFn: async () => ({ id: 'job_ex_1' }),
  });

  assert.equal(invalidRes.status, 'exception');
  assert.equal(invalidRes.credited, false);
  assert.equal(invalidRes.reason, 'missing_required_memo');
  assert.equal(invalidRes.exceptionRecord.routed, true);
});

test('resolveExceptionDeposit: operator manually credits user from reconciliation dashboard', async () => {
  const mockCheckpoint = {
    id: 'chk_123',
    transactionId: 'tx_unmatched_1',
    checkpointType: 'memo_exception',
    status: 'mismatch',
    mismatchDetails: {
      amount: '75.0000000',
      asset: 'USDC',
      destination: 'GABC_EXCHANGE',
    },
  };

  let updatedCheckpointStatus = null;
  const ledgerEntries = [];
  const mockPrisma = {
    reconciliationCheckpoint: {
      findUnique: async () => mockCheckpoint,
      update: async ({ data }) => {
        updatedCheckpointStatus = data.status;
        return { ...mockCheckpoint, ...data };
      },
    },
    user: {
      findUnique: async ({ where }) => (where.id === 'user_target_99' ? { id: 'user_target_99' } : null),
    },
    ledgerAccount: {
      findUnique: async () => ({ id: 'acc_1' }),
      create: async () => ({ id: 'acc_1' }),
    },
    journalEntry: {
      create: async ({ data }) => {
        ledgerEntries.push(data);
        return { id: 'entry_2', ...data };
      },
    },
    ledgerPosting: {
      create: async () => ({ id: 'post_2' }),
    },
    $transaction: async (fn) => fn(mockPrisma),
  };

  const res = await resolveExceptionDeposit({
    checkpointId: 'chk_123',
    targetUserId: 'user_target_99',
    adminId: 'admin_alice',
    resolutionReason: 'User showed receipt proving deposit ownership',
    prisma: mockPrisma,
  });

  assert.equal(res.success, true);
  assert.equal(res.credited, true);
  assert.equal(res.targetUserId, 'user_target_99');
  assert.equal(updatedCheckpointStatus, 'success');
  assert.equal(ledgerEntries.length, 1);
  assert.equal(ledgerEntries[0].eventType, 'deposit.reconciled_credit');
});
