const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { convert } = require('../src/utils/money');

const injectMock = (relativeFromSrc, factory) => {
  const abs = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[abs] = {
    id: abs,
    filename: abs,
    loaded: true,
    exports: factory(),
  };
};

injectMock('config/env', () => ({
  compliance: {
    policyCurrency: 'NGN',
    policyVersion: '1',
    policyFxMaxAgeMs: 300000,
  },
  pricing: {
    exchangeRateApiKey: 'test-fx-key',
    coinGeckoApiKey: 'test-cg-key',
    coinGeckoBaseUrl: 'https://api.coingecko.com/api/v3',
    coinGeckoTimeoutMs: 10000,
  },
}));

const {
  getPolicyConversionSnapshot,
  POLICY_ERROR_CODES,
  multiplyDecimalRates,
} = require('../src/pricing/policyRate');

const now = new Date('2026-08-28T09:00:00.000Z');

test('identity NGN snapshot uses rate 1 without providers', async () => {
  const snapshot = await getPolicyConversionSnapshot({
    sourceAsset: 'NGN',
    amount: '15000.00',
    now,
    fetchFiatRate: async () => {
      throw new Error('fiat provider must not be called for identity');
    },
    fetchCryptoUsdRate: async () => {
      throw new Error('crypto provider must not be called for identity');
    },
  });

  assert.equal(snapshot.source, 'identity');
  assert.equal(snapshot.rate, '1');
  assert.equal(snapshot.convertedAmount, '15000.00');
  assert.equal(snapshot.referenceCurrency, 'NGN');
  assert.equal(snapshot.policyVersion, '1');
  assert.equal(snapshot.fetchedAt, now.toISOString());
});

test('USDC uses USD→NGN peg and convert() HALF_UP into NGN', async () => {
  const snapshot = await getPolicyConversionSnapshot({
    sourceAsset: 'USDC',
    amount: '1.0000000',
    now,
    fetchFiatRate: async () => ({ rate: '1550.00', fetchedAt: now }),
  });

  assert.equal(snapshot.source, 'exchangerate-api');
  assert.equal(snapshot.rate, '1550.00');
  assert.equal(
    snapshot.convertedAmount,
    convert({ amount: '1.0000000', sourceAsset: 'USDC', targetAsset: 'NGN', rate: '1550.00' }),
  );
  assert.equal(snapshot.convertedAmount, '1550.00');
});

test('XLM composite rate multiplies CoinGecko USD and fiat NGN without Number', async () => {
  const xlmUsd = '0.20';
  const usdNgn = '1550.00';
  const expectedRate = multiplyDecimalRates(xlmUsd, usdNgn);
  assert.equal(expectedRate, '310');

  const snapshot = await getPolicyConversionSnapshot({
    sourceAsset: 'XLM',
    amount: '5.0000000',
    now,
    fetchCryptoUsdRate: async () => ({ rate: xlmUsd, fetchedAt: now }),
    fetchFiatRate: async () => ({ rate: usdNgn, fetchedAt: now }),
  });

  assert.equal(snapshot.source, 'composite:coingecko+exchangerate-api');
  assert.equal(snapshot.rate, expectedRate);
  assert.equal(
    snapshot.convertedAmount,
    convert({ amount: '5.0000000', sourceAsset: 'XLM', targetAsset: 'NGN', rate: expectedRate }),
  );
  assert.equal(snapshot.convertedAmount, '1550.00');
});

test('economically equivalent USDC and XLM convert to the same NGN amount', async () => {
  const usdc = await getPolicyConversionSnapshot({
    sourceAsset: 'USDC',
    amount: '1.0000000',
    now,
    fetchFiatRate: async () => ({ rate: '1550.00', fetchedAt: now }),
  });
  const xlm = await getPolicyConversionSnapshot({
    sourceAsset: 'XLM',
    amount: '5.0000000',
    now,
    fetchCryptoUsdRate: async () => ({ rate: '0.20', fetchedAt: now }),
    fetchFiatRate: async () => ({ rate: '1550.00', fetchedAt: now }),
  });
  assert.equal(usdc.convertedAmount, xlm.convertedAmount);
  assert.equal(usdc.convertedAmount, '1550.00');
});

test('HALF_UP rounding to NGN cents is exact', async () => {
  const up = await getPolicyConversionSnapshot({
    sourceAsset: 'USDC',
    amount: '1.0000000',
    now,
    fetchFiatRate: async () => ({ rate: '19999.995', fetchedAt: now }),
  });
  const down = await getPolicyConversionSnapshot({
    sourceAsset: 'USDC',
    amount: '1.0000000',
    now,
    fetchFiatRate: async () => ({ rate: '19999.994', fetchedAt: now }),
  });

  assert.equal(
    up.convertedAmount,
    convert({ amount: '1.0000000', sourceAsset: 'USDC', targetAsset: 'NGN', rate: '19999.995' }),
  );
  assert.equal(
    down.convertedAmount,
    convert({ amount: '1.0000000', sourceAsset: 'USDC', targetAsset: 'NGN', rate: '19999.994' }),
  );
  assert.equal(up.convertedAmount, '20000.00');
  assert.equal(down.convertedAmount, '19999.99');
});

test('stale fiat rate fails closed with POLICY_FX_STALE', async () => {
  const stale = new Date(now.getTime() - 300001);
  await assert.rejects(
    () => getPolicyConversionSnapshot({
      sourceAsset: 'USDC',
      amount: '1.0000000',
      now,
      fetchFiatRate: async () => ({ rate: '1550.00', fetchedAt: stale }),
    }),
    (error) => {
      assert.equal(error.code, POLICY_ERROR_CODES.FX_STALE);
      return true;
    },
  );
});

test('provider failure fails closed with POLICY_FX_UNAVAILABLE', async () => {
  await assert.rejects(
    () => getPolicyConversionSnapshot({
      sourceAsset: 'USDC',
      amount: '1.0000000',
      now,
      fetchFiatRate: async () => null,
    }),
    (error) => {
      assert.equal(error.code, POLICY_ERROR_CODES.FX_UNAVAILABLE);
      return true;
    },
  );

  await assert.rejects(
    () => getPolicyConversionSnapshot({
      sourceAsset: 'XLM',
      amount: '1.0000000',
      now,
      fetchCryptoUsdRate: async () => ({ rate: '0.20', fetchedAt: now }),
      fetchFiatRate: async () => {
        throw new Error('upstream down');
      },
    }),
    (error) => {
      assert.equal(error.code, POLICY_ERROR_CODES.FX_UNAVAILABLE);
      return true;
    },
  );
});
