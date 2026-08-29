const { test, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const axiosGet = mock.fn();
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: { get: axiosGet } };

const configPath = path.resolve(__dirname, '../src/config/env.js');
delete require.cache[configPath];
const config = require('../src/config/env');
Object.assign(config.pricing, {
  exchangeRateApiKey: 'test-key',
  timeoutMs: 1,
  maxRetries: 0,
  circuitThreshold: 1,
  circuitCooldownMs: 60000,
  cacheMaxAgeMs: 50,
  staleCacheMaxAgeMs: 60000,
  maxSourceAgeMs: 86400000,
  maxRate: '1000000000',
});

const servicePath = path.resolve(__dirname, '../src/pricing/pricing.service.js');
delete require.cache[servicePath];
const {
  fetchExchangeRateQuote,
  validateProviderPayload,
  PricingProviderError,
  resetPricingPolicyState,
} = require('../src/pricing/pricing.service');

beforeEach(() => {
  resetPricingPolicyState();
  Object.assign(config.pricing, { circuitThreshold: 1, circuitCooldownMs: 60000, cacheMaxAgeMs: 50 });
});

test('validateProviderPayload rejects invalid and stale provider data', () => {
  assert.throws(
    () => validateProviderPayload({ payload: '{}', sourceCurrency: 'NGN', targetCurrency: 'USDC' }),
    { code: 'PRICING_INVALID_DATA' }
  );

  assert.throws(
    () => validateProviderPayload({
      payload: JSON.stringify({ conversion_rate: 0.001, time_last_update_unix: 1 }),
      sourceCurrency: 'NGN',
      targetCurrency: 'USDC',
      now: new Date('2026-08-26T00:00:00Z'),
    }),
    { code: 'PRICING_STALE_DATA' }
  );
});

test('fetchExchangeRateQuote fails fast once the pricing circuit opens', async () => {
  axiosGet.mock.resetCalls();
  axiosGet.mock.mockImplementation(async () => {
    const err = new Error('timeout of 1ms exceeded');
    err.code = 'ECONNABORTED';
    throw err;
  });

  await assert.rejects(
    () => fetchExchangeRateQuote({ sourceCurrency: 'USD', targetCurrency: 'EUR' }),
    /timeout/
  );
  await assert.rejects(
    () => fetchExchangeRateQuote({ sourceCurrency: 'USD', targetCurrency: 'EUR' }),
    { code: 'PRICING_OPEN_CIRCUIT' }
  );
  assert.equal(axiosGet.mock.callCount(), 1);
});

test('fetchExchangeRateQuote can return a stale cached rate after a provider outage', async () => {
  axiosGet.mock.resetCalls();
  config.pricing.circuitThreshold = 10;
  axiosGet.mock.mockImplementationOnce(async () => ({
    data: JSON.stringify({ conversion_rate: 0.8, time_last_update_unix: Math.floor(Date.now() / 1000) }),
  }));

  const first = await fetchExchangeRateQuote({ sourceCurrency: 'GBP', targetCurrency: 'USD' });
  assert.equal(first.effectiveRate, '0.8');
  await new Promise((resolve) => setTimeout(resolve, 60));

  axiosGet.mock.mockImplementation(async () => {
    throw new PricingProviderError('PRICING_UNAVAILABLE', 'provider down');
  });
  const fallback = await fetchExchangeRateQuote({ sourceCurrency: 'GBP', targetCurrency: 'USD' });
  assert.equal(fallback.effectiveRate, '0.8');
  assert.equal(fallback.stale, true);
});
