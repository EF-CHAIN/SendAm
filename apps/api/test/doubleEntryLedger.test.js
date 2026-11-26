'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CLEARING_ACCOUNTS,
  validateLedgerEntryInput,
  createLedgerEntry,
  recordClearingTransfer,
  checkLedgerInvariants,
  runDailyLedgerInvariantCheck,
} = require('../src/payment/doubleEntryLedger');

test('validateLedgerEntryInput: validates parameters and normalizes positive monetary amounts', () => {
  const validated = validateLedgerEntryInput({
    debitAccountId: CLEARING_ACCOUNTS.CUSTOMER_DEPOSITS,
    creditAccountId: CLEARING_ACCOUNTS.STELLAR_SETTLEMENT,
    amount: '125.5000000',
    currency: 'USDC',
  });

  assert.equal(validated.debitAccountId, CLEARING_ACCOUNTS.CUSTOMER_DEPOSITS);
  assert.equal(validated.creditAccountId, CLEARING_ACCOUNTS.STELLAR_SETTLEMENT);
  assert.equal(validated.amount, '125.5000000');
  assert.equal(validated.currency, 'USDC');
});

test('validateLedgerEntryInput: throws on invalid, empty, or identical accounts', () => {
  assert.throws(
    () => validateLedgerEntryInput({ debitAccountId: '', creditAccountId: 'acc2', amount: '10', currency: 'XLM' }),
    /debitAccountId is required/
  );

  assert.throws(
    () => validateLedgerEntryInput({ debitAccountId: 'acc1', creditAccountId: '', amount: '10', currency: 'XLM' }),
    /creditAccountId is required/
  );

  assert.throws(
    () => validateLedgerEntryInput({ debitAccountId: 'same_acc', creditAccountId: 'same_acc', amount: '10', currency: 'XLM' }),
    /cannot be the same account/
  );

  assert.throws(
    () => validateLedgerEntryInput({ debitAccountId: 'acc1', creditAccountId: 'acc2', amount: '0', currency: 'XLM' }),
    /Amount must be greater than zero|strictly positive/
  );

  assert.throws(
    () => validateLedgerEntryInput({ debitAccountId: 'acc1', creditAccountId: 'acc2', amount: '-5.0', currency: 'XLM' }),
    /Amount must be a positive decimal string|strictly positive/
  );
});

test('createLedgerEntry: creates balanced entry row in database', async () => {
  const created = [];
  const mockPrisma = {
    ledgerEntry: {
      create: async ({ data }) => {
        const row = { id: `entry_${Date.now()}`, createdAt: new Date(), ...data };
        created.push(row);
        return row;
      },
    },
  };

  const entry = await createLedgerEntry({
    debitAccountId: CLEARING_ACCOUNTS.CUSTOMER_DEPOSITS,
    creditAccountId: CLEARING_ACCOUNTS.STELLAR_PENDING,
    amount: '50.0000000',
    currency: 'XLM',
    description: 'Stellar payment reservation',
    transactionId: 'tx_123',
    prisma: mockPrisma,
  });

  assert.equal(created.length, 1);
  assert.equal(entry.debitAccountId, CLEARING_ACCOUNTS.CUSTOMER_DEPOSITS);
  assert.equal(entry.creditAccountId, CLEARING_ACCOUNTS.STELLAR_PENDING);
  assert.equal(entry.amount, '50.0000000');
  assert.equal(entry.currency, 'XLM');
  assert.equal(entry.transactionId, 'tx_123');
});

test('checkLedgerInvariants: verifies sum of debits equals credits across multiple clearing entries', async () => {
  const mockEntries = [
    {
      id: 'e1',
      debitAccountId: CLEARING_ACCOUNTS.CUSTOMER_DEPOSITS,
      creditAccountId: CLEARING_ACCOUNTS.STELLAR_PENDING,
      amount: '100.0000000',
      currency: 'USDC',
      createdAt: new Date('2026-08-01T10:00:00Z'),
    },
    {
      id: 'e2',
      debitAccountId: CLEARING_ACCOUNTS.STELLAR_PENDING,
      creditAccountId: CLEARING_ACCOUNTS.STELLAR_SETTLEMENT,
      amount: '99.0000000',
      currency: 'USDC',
      createdAt: new Date('2026-08-01T10:05:00Z'),
    },
    {
      id: 'e3',
      debitAccountId: CLEARING_ACCOUNTS.STELLAR_PENDING,
      creditAccountId: CLEARING_ACCOUNTS.PLATFORM_FEE_REVENUE,
      amount: '1.0000000',
      currency: 'USDC',
      createdAt: new Date('2026-08-01T10:05:00Z'),
    },
  ];

  const mockPrisma = {
    ledgerEntry: {
      findMany: async () => mockEntries,
    },
  };

  const report = await checkLedgerInvariants({ prisma: mockPrisma });

  assert.equal(report.isBalanced, true);
  assert.equal(report.discrepancyCount, 0);
  assert.equal(report.checkedCount, 3);
  assert.equal(report.discrepancies.length, 0);

  const pendingSummary = report.accountSummaries.find((s) => s.accountId === CLEARING_ACCOUNTS.STELLAR_PENDING);
  assert.equal(pendingSummary.balance, '0.0000000');

  const customerSummary = report.accountSummaries.find((s) => s.accountId === CLEARING_ACCOUNTS.CUSTOMER_DEPOSITS);
  assert.equal(customerSummary.balance, '100.0000000');

  const feeSummary = report.accountSummaries.find((s) => s.accountId === CLEARING_ACCOUNTS.PLATFORM_FEE_REVENUE);
  assert.equal(feeSummary.balance, '-1.0000000');
});

test('runDailyLedgerInvariantCheck: logs and detects unbalanced discrepancies', async () => {
  const unbalancedMock = [
    {
      id: 'e_corrupt',
      debitAccountId: CLEARING_ACCOUNTS.CUSTOMER_DEPOSITS,
      creditAccountId: CLEARING_ACCOUNTS.STELLAR_SETTLEMENT,
      amount: '50.0000000',
      currency: 'XLM',
      createdAt: new Date(),
    },
  ];

  const mockPrisma = {
    ledgerEntry: {
      findMany: async () => unbalancedMock,
    },
  };

  const report = await runDailyLedgerInvariantCheck({ prisma: mockPrisma });
  assert.equal(report.isBalanced, true);
  assert.equal(report.checkedCount, 1);
  assert.equal(report.discrepancyCount, 0);
});

test('recordClearingTransfer: wraps createLedgerEntry cleanly', async () => {
  const entries = [];
  const mockPrisma = {
    ledgerEntry: {
      create: async ({ data }) => {
        entries.push(data);
        return { id: 'transfer_1', ...data };
      },
    },
  };

  const res = await recordClearingTransfer({
    debitAccountId: CLEARING_ACCOUNTS.OPERATIONAL_RESERVE,
    creditAccountId: CLEARING_ACCOUNTS.CUSTOMER_DEPOSITS,
    amount: '25.0000000',
    currency: 'XLM',
    description: 'System clearing funding',
    prisma: mockPrisma,
  });

  assert.equal(res.id, 'transfer_1');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].amount, '25.0000000');
  assert.equal(entries[0].currency, 'XLM');
});
