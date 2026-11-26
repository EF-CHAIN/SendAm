'use strict';

const defaultPrisma = () => require('../common/prisma');
const logger = require('../utils/logger');
const { assertValidAmount, parseUnits, formatUnits, getAssetRule } = require('../utils/money');

const CLEARING_ACCOUNTS = Object.freeze({
  CUSTOMER_DEPOSITS: 'clearing:customer_deposits',
  STELLAR_SETTLEMENT: 'clearing:stellar_settlement',
  STELLAR_PENDING: 'clearing:stellar_pending',
  PLATFORM_FEE_REVENUE: 'clearing:platform_fee_revenue',
  OPERATIONAL_RESERVE: 'clearing:operational_reserve',
  OFFRAMP_SUSPENSE: 'clearing:offramp_suspense',
  EXCHANGE_CLEARING: 'clearing:exchange_clearing',
});

const validateLedgerEntryInput = ({
  debitAccountId,
  creditAccountId,
  amount,
  currency,
}) => {
  if (!debitAccountId || typeof debitAccountId !== 'string' || !debitAccountId.trim()) {
    throw new Error('debitAccountId is required and must be a non-empty string.');
  }

  if (!creditAccountId || typeof creditAccountId !== 'string' || !creditAccountId.trim()) {
    throw new Error('creditAccountId is required and must be a non-empty string.');
  }

  if (debitAccountId.trim() === creditAccountId.trim()) {
    throw new Error('debitAccountId and creditAccountId cannot be the same account.');
  }

  if (!currency || typeof currency !== 'string' || !currency.trim()) {
    throw new Error('currency is required and must be a valid asset code.');
  }

  const effectiveCurrency = currency.trim().toUpperCase();
  const normalizedAmount = assertValidAmount(amount, effectiveCurrency);

  const rule = getAssetRule(effectiveCurrency);
  const units = parseUnits(normalizedAmount, rule.precision);
  if (units <= 0n) {
    throw new Error('Ledger entry amount must be strictly positive.');
  }

  return {
    debitAccountId: debitAccountId.trim(),
    creditAccountId: creditAccountId.trim(),
    amount: normalizedAmount,
    currency: effectiveCurrency,
  };
};

const createLedgerEntry = async ({
  debitAccountId,
  creditAccountId,
  amount,
  currency,
  description = null,
  transactionId = null,
  reference = null,
  metadata = {},
  prisma = defaultPrisma(),
}) => {
  const validated = validateLedgerEntryInput({
    debitAccountId,
    creditAccountId,
    amount,
    currency,
  });

  const entryData = {
    debitAccountId: validated.debitAccountId,
    creditAccountId: validated.creditAccountId,
    amount: validated.amount,
    currency: validated.currency,
    description: description ? String(description) : null,
    transactionId: transactionId ? String(transactionId) : null,
    reference: reference ? String(reference) : null,
    metadata,
  };

  const client = prisma || defaultPrisma();
  return client.ledgerEntry.create({
    data: entryData,
  });
};

const recordClearingTransfer = async ({
  debitAccountId,
  creditAccountId,
  amount,
  currency,
  description,
  transactionId,
  reference,
  metadata,
  prisma = defaultPrisma(),
}) => {
  return createLedgerEntry({
    debitAccountId,
    creditAccountId,
    amount,
    currency,
    description,
    transactionId,
    reference,
    metadata,
    prisma,
  });
};

const checkLedgerInvariants = async ({
  prisma = defaultPrisma(),
  currency,
  maxEntries = 10000,
} = {}) => {
  const client = prisma || defaultPrisma();
  const where = {};
  if (currency) {
    where.currency = String(currency).trim().toUpperCase();
  }

  const entries = await client.ledgerEntry.findMany({
    where,
    take: maxEntries,
    orderBy: { createdAt: 'asc' },
  });

  const balancesPerCurrency = new Map();
  const accountBalances = new Map();

  for (const entry of entries) {
    const assetRule = getAssetRule(entry.currency);
    const units = parseUnits(entry.amount, assetRule.precision);

    if (!balancesPerCurrency.has(entry.currency)) {
      balancesPerCurrency.set(entry.currency, {
        totalDebits: 0n,
        totalCredits: 0n,
        precision: assetRule.precision,
      });
    }

    const currRecord = balancesPerCurrency.get(entry.currency);
    currRecord.totalDebits += units;
    currRecord.totalCredits += units;

    const debitKey = `${entry.currency}:::${entry.debitAccountId}`;
    const creditKey = `${entry.currency}:::${entry.creditAccountId}`;

    accountBalances.set(debitKey, (accountBalances.get(debitKey) || 0n) + units);
    accountBalances.set(creditKey, (accountBalances.get(creditKey) || 0n) - units);
  }

  const discrepancies = [];
  let isBalanced = true;

  for (const [currCode, stat] of balancesPerCurrency.entries()) {
    const diff = stat.totalDebits - stat.totalCredits;
    if (diff !== 0n) {
      isBalanced = false;
      discrepancies.push({
        currency: currCode,
        totalDebits: formatUnits(stat.totalDebits, stat.precision),
        totalCredits: formatUnits(stat.totalCredits, stat.precision),
        discrepancy: formatUnits(diff, stat.precision),
      });
    }
  }

  const accountSummaries = [];
  for (const [key, bal] of accountBalances.entries()) {
    const [currCode, accId] = key.split(':::');
    const assetRule = getAssetRule(currCode);
    accountSummaries.push({
      accountId: accId,
      currency: currCode,
      balance: formatUnits(bal, assetRule.precision),
    });
  }

  return {
    isBalanced,
    checkedCount: entries.length,
    discrepancyCount: discrepancies.length,
    discrepancies,
    accountSummaries,
    verifiedAt: new Date().toISOString(),
  };
};

const runDailyLedgerInvariantCheck = async ({
  prisma = defaultPrisma(),
  log = logger,
} = {}) => {
  const result = await checkLedgerInvariants({ prisma });

  if (!result.isBalanced) {
    log.error('daily_ledger_invariant_discrepancy_detected', {
      discrepancies: result.discrepancies,
      checkedCount: result.checkedCount,
    });
  } else {
    log.info('daily_ledger_invariant_check_passed', {
      checkedCount: result.checkedCount,
      discrepancyCount: 0,
      verifiedAt: result.verifiedAt,
    });
  }

  return result;
};

module.exports = {
  CLEARING_ACCOUNTS,
  validateLedgerEntryInput,
  createLedgerEntry,
  recordClearingTransfer,
  checkLedgerInvariants,
  runDailyLedgerInvariantCheck,
};
