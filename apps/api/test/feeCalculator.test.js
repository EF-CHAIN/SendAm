'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  FEE_RULE_MATCH,
  FeeRuleError,
  calculateFee,
  normalizeFeeRule,
  resolveFeeRule,
  priceWithRules,
} = require('../src/pricing/feeCalculator');
const {
  calculateQuoteFee,
  createFeeRule,
  resetFeeRuleCache,
} = require('../src/pricing/feeRule.service');

const xlmRule = {
  sourceCurrency: 'XLM',
  targetCurrency: '*',
  rateBps: 100,
  baseCost: '0.0500000',
  minFee: '0.2000000',
  maxFee: '5.0000000',
  priority: 10,
  version: 3,
};

test('clamps the fee at minFee for micro-payments and keeps the margin positive', () => {
  const quote = calculateFee({ amount: '0.5000000', asset: 'XLM', rule: xlmRule });
  assert.equal(quote.variableFee, '0.0050000');
  assert.equal(quote.fee, '0.2000000');
  assert.equal(quote.clamped, 'min');
  assert.equal(quote.margin, '0.1500000');
  assert.equal(quote.marginPositive, true);
  assert.equal(quote.netAmount, '0.3000000');
});

test('charges percentage plus base cost between the clamps', () => {
  const quote = calculateFee({ amount: '100.0000000', asset: 'XLM', rule: xlmRule });
  // 1% of 100 = 1.0, plus 0.05 base cost.
  assert.equal(quote.variableFee, '1.0000000');
  assert.equal(quote.fee, '1.0500000');
  assert.equal(quote.clamped, null);
  assert.equal(quote.margin, '1.0000000');
});

test('clamps the fee at maxFee for large payments', () => {
  const quote = calculateFee({ amount: '10000.0000000', asset: 'XLM', rule: xlmRule });
  assert.equal(quote.fee, '5.0000000');
  assert.equal(quote.clamped, 'max');
  assert.equal(quote.marginPositive, true);
});

test('margin stays positive across every transaction size the corridor can settle', () => {
  const amounts = ['0.2000001', '0.21', '1', '12.5', '999.9999999', '100000'];
  const baseUnits = 0.05;
  for (const amount of amounts) {
    const quote = calculateFee({ amount, asset: 'XLM', rule: xlmRule });
    assert.ok(Number(quote.margin) > 0, `margin must be positive for ${amount} XLM`);
    assert.ok(Number(quote.fee) > baseUnits, `fee must recover the fixed cost for ${amount} XLM`);
    assert.ok(Number(quote.netAmount) > 0, `net amount must remain positive for ${amount} XLM`);
  }
});

test('rejects a fee that would consume the whole payment', () => {
  assert.throws(
    () => calculateFee({ amount: '0.1500000', asset: 'XLM', rule: xlmRule }),
    (error) => error instanceof FeeRuleError && error.code === 'FEE_EXCEEDS_AMOUNT',
  );
});

test('a persisted rule that violates the margin invariant is never used to price a payment', () => {
  const invalid = { ...xlmRule, id: 'legacy', minFee: '0.0100000', baseCost: '0.0500000' };
  assert.throws(
    () => normalizeFeeRule(invalid),
    (error) => error.code === 'FEE_RULE_INVALID' && /greater than baseCost/.test(error.message),
  );

  const rule = resolveFeeRule({ rules: [invalid, { ...xlmRule, id: 'valid' }], sourceCurrency: 'XLM', targetCurrency: 'USDC', asset: 'XLM' });
  assert.equal(rule.id, 'valid');
});

test('rejects rules whose cap is below the floor or whose percentages are out of range', () => {
  assert.throws(
    () => normalizeFeeRule({ ...xlmRule, maxFee: '0.1000000' }),
    (error) => error.code === 'FEE_RULE_INVALID' && /maxFee/.test(error.message),
  );
  assert.throws(
    () => normalizeFeeRule({ ...xlmRule, rateBps: 10001 }),
    (error) => error.code === 'FEE_RULE_INVALID',
  );
  assert.throws(
    () => normalizeFeeRule({ ...xlmRule, baseCost: '-1' }),
    (error) => error.code === 'FEE_RULE_INVALID',
  );
});

test('resolves per-corridor rules most-specific-first', () => {
  const rules = [
    { id: 'global', sourceCurrency: '*', targetCurrency: '*', rateBps: 100, baseCost: '0.01', minFee: '0.02' },
    { id: 'target-only', sourceCurrency: '*', targetCurrency: 'USDC', rateBps: 100, baseCost: '0.02', minFee: '0.03' },
    { id: 'source-only', sourceCurrency: 'NGN', targetCurrency: '*', rateBps: 150, baseCost: '10', minFee: '25' },
    { id: 'corridor', sourceCurrency: 'NGN', targetCurrency: 'USDC', rateBps: 200, baseCost: '20', minFee: '50' },
    { id: 'inactive', sourceCurrency: 'NGN', targetCurrency: 'USDC', rateBps: 900, baseCost: '1', minFee: '2', active: false },
  ];

  const corridor = resolveFeeRule({ rules, sourceCurrency: 'NGN', targetCurrency: 'USDC', asset: 'NGN' });
  assert.equal(corridor.id, 'corridor');
  assert.equal(corridor.match, FEE_RULE_MATCH.CORRIDOR);

  const sourceOnly = resolveFeeRule({ rules, sourceCurrency: 'NGN', targetCurrency: 'XLM', asset: 'NGN' });
  assert.equal(sourceOnly.id, 'source-only');
  assert.equal(sourceOnly.match, FEE_RULE_MATCH.SOURCE);

  const targetOnly = resolveFeeRule({ rules, sourceCurrency: 'EUR', targetCurrency: 'USDC', asset: 'EUR' });
  assert.equal(targetOnly.id, 'target-only');

  const fallback = resolveFeeRule({ rules, sourceCurrency: 'GBP', targetCurrency: 'GHS', asset: 'GBP' });
  assert.equal(fallback.id, 'global');
});

test('prices per-corridor rules in the source asset precision', () => {
  const rules = [
    { id: 'ngn-usdc', sourceCurrency: 'NGN', targetCurrency: 'USDC', rateBps: 150, baseCost: '10.00', minFee: '25.00' },
  ];
  const micro = priceWithRules({ amount: '500.00', asset: 'NGN', sourceCurrency: 'NGN', targetCurrency: 'USDC', rules });
  assert.equal(micro.fee, '25.00');
  assert.equal(micro.clamped, 'min');
  assert.equal(micro.rule.id, 'ngn-usdc');

  const normal = priceWithRules({ amount: '10000.00', asset: 'NGN', sourceCurrency: 'NGN', targetCurrency: 'USDC', rules });
  // 1.5% of 10000 = 150, plus 10 fixed.
  assert.equal(normal.fee, '160.00');
  assert.equal(normal.margin, '150.00');
});

test('falls back to the built-in schedule when no rule matches or is persisted', async () => {
  resetFeeRuleCache();
  const quote = await calculateQuoteFee({ db: {}, amount: '500', asset: 'XLM', sourceCurrency: 'XLM', targetCurrency: 'USDC' });
  assert.equal(quote.rule.source, 'builtin');
  assert.equal(quote.rule.match, FEE_RULE_MATCH.SOURCE);
  assert.ok(Number(quote.margin) > 0);
});

test('admin-created rules are validated, audited and immediately usable for quoting', async () => {
  resetFeeRuleCache();
  const rows = [];
  const db = {
    feeRule: {
      findMany: async ({ where } = {}) => rows.filter((row) => !where?.active || row.active),
      findUnique: async ({ where }) => rows.find((row) => (
        where.id ? row.id === where.id : row.sourceCurrency === where.sourceCurrency_targetCurrency?.sourceCurrency
      )) || null,
      create: async ({ data }) => {
        const row = { id: `fee_${rows.length + 1}`, ...data, version: data.version ?? 1 };
        rows.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const index = rows.findIndex((row) => row.id === where.id);
        rows[index] = { ...rows[index], ...data };
        return rows[index];
      },
      delete: async ({ where }) => {
        const index = rows.findIndex((row) => row.id === where.id);
        return rows.splice(index, 1)[0];
      },
    },
  };
  const created = await createFeeRule({
    db,
    actorId: 'admin_1',
    input: { sourceCurrency: 'xlm', targetCurrency: 'usdc', rateBps: 250, baseCost: '0.02', minFee: '0.1', maxFee: '10' },
  });
  assert.equal(created.sourceCurrency, 'XLM');
  assert.equal(created.targetCurrency, 'USDC');
  assert.equal(created.version, 1);

  await assert.rejects(
    () => createFeeRule({ db, input: { minFee: '0.01', baseCost: '0.05' } }),
    (error) => error.code === 'FEE_RULE_INVALID',
  );

  // The new rule takes effect for the very next quote without any cache reset.
  const quote = await calculateQuoteFee({ db, amount: '0.2', asset: 'XLM', sourceCurrency: 'XLM', targetCurrency: 'USDC' });
  assert.equal(quote.rule.id, created.id);
  assert.equal(quote.fee, '0.1000000');
  assert.equal(quote.marginPositive, true);
  resetFeeRuleCache();
});
