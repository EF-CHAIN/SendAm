const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  TIER_LIMITS,
  toUsdCents,
  enforceVelocityLimit,
} = require('../src/compliance/velocityLimits');

test('rolling limits match the configured KYC tiers and USD values remain exact', async () => {
  assert.deepEqual(TIER_LIMITS[0], { dailyUsdCents: 5000, hourlyTransactions: 2 });
  assert.deepEqual(TIER_LIMITS[1], { dailyUsdCents: 50000, hourlyTransactions: 5 });
  assert.deepEqual(TIER_LIMITS[2], { dailyUsdCents: 500000, hourlyTransactions: null });
  assert.equal(await toUsdCents({ referenceAmount: '12.34', referenceCurrency: 'USD' }), 1234);
});

test('Redis sliding-window reservation uses the sender tier and unique reservation', async () => {
  let args;
  const redis = {
    eval: async (...values) => {
      args = values;
      return [1, 'ok'];
    },
  };
  const result = await enforceVelocityLimit({
    user: { id: 'user-1', kycTier: 0 },
    referenceAmount: '1.00',
    referenceCurrency: 'USD',
    reservationId: 'payment-1',
    redis,
  });
  assert.equal(result.enforced, true);
  assert.equal(args[0].includes('ZCOUNT'), true);
  assert.equal(args[7], '100:payment-1');
});
