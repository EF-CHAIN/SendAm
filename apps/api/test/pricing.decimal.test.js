process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://sendam:secret@localhost:5432/sendam';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertConfiguredCurrency, createQuote } = require('../src/pricing/pricing.service');
const { reconcileMonetaryValues } = require('../src/payment/payment.reconciler');

test('assertConfiguredCurrency supports default and custom configured fiat currencies', () => {
  assert.equal(assertConfiguredCurrency('NGN'), 'NGN');
  assert.equal(assertConfiguredCurrency('USD'), 'USD');
  assert.equal(assertConfiguredCurrency('EUR'), 'EUR');
  assert.equal(assertConfiguredCurrency('GBP'), 'GBP');
  assert.equal(assertConfiguredCurrency('XLM'), 'XLM');
  assert.equal(assertConfiguredCurrency('USDC'), 'USDC');
});

test('reconcileMonetaryValues audits and fixes non-canonical database monetary values', async () => {
  const fakeQuotes = [
    { id: 'q1', sourceAmount: '10.5000', sourceCurrency: 'NGN', targetAmount: '0.007', targetCurrency: 'USDC', rate: '0.0006666666666', fee: '0.1000' },
  ];
  const fakeTransactions = [
    { id: 'tx1', amount: '5.100000000', asset: 'XLM' },
  ];

  const updatedQuotes = [];
  const updatedTransactions = [];

  const mockPrisma = {
    quote: {
      findMany: async () => fakeQuotes,
      update: async ({ where, data }) => {
        updatedQuotes.push({ id: where.id, data });
        return { ...fakeQuotes[0], ...data };
      },
    },
    transaction: {
      findMany: async () => fakeTransactions,
      update: async ({ where, data }) => {
        updatedTransactions.push({ id: where.id, data });
        return { ...fakeTransactions[0], ...data };
      },
    },
  };

  const result = await reconcileMonetaryValues({
    prisma: mockPrisma,
    apply: true,
    loggerInstance: { info: () => {}, warn: () => {}, error: () => {} },
  });

  assert.equal(result.checkedCount, 2);
  assert.equal(result.invalidCount, 2);
  assert.equal(result.fixedCount, 2);
  assert.equal(updatedQuotes.length, 1);
  assert.equal(updatedQuotes[0].data.sourceAmount, '10.50');
  assert.equal(updatedTransactions[0].data.amount, '5.1000000');
});

test('createQuote persists provider provenance and customer-visible expiry inputs', async () => {
  let persisted;
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  const mockPrisma = {
    quote: {
      create: async ({ data }) => {
        persisted = data;
        return { id: 'quote_prov_1', ...data };
      },
    },
  };

  const quote = await createQuote({
    userId: 'user_1',
    sourceCurrency: 'XLM',
    targetCurrency: 'XLM',
    sourceAmount: '5.0000000',
    route: 'stellar',
    provider: 'stellar',
    expiresAt,
    tx: mockPrisma,
  });

  assert.equal(quote.rate, '1');
  assert.equal(persisted.sourceTimestamp instanceof Date, true);
  assert.equal(persisted.spread, '0');
  assert.equal(persisted.feePolicyVersion, 'standard-v1');
  assert.equal(persisted.providerResponse.effectiveRate, '1');
  assert.equal(persisted.expiresAt, expiresAt);
});
