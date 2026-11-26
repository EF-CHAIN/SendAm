const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config/env');
const {
  fetchAggregatedRate,
  median,
  disagreementBps,
  resetFxAggregatorState,
  FxAggregatorError,
  FX_ERROR_CODES,
} = require('../src/pricing/fxAggregator');

const originalPricing = { ...config.pricing };

const provider = (name, impl) => ({ name, fetch: impl });

beforeEach(() => {
  resetFxAggregatorState();
  Object.assign(config.pricing, {
    fxMaxRateAgeMs: 60000,
    fxMinProviders: 1,
    fxMaxDisagreementBps: 10000,
    fxAlertWebhookUrl: null,
    fxAlertCooldownMs: 0,
    maxRetries: 0,
    circuitThreshold: 3,
    circuitCooldownMs: 30000,
    staleCacheMaxAgeMs: 300000,
  });
});

afterEach(() => {
  Object.assign(config.pricing, originalPricing);
});

test('median handles odd and even samples and ignores invalid values', () => {
  assert.equal(median([1, 3, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([0, -1, NaN, Infinity]), null);
  assert.equal(disagreementBps([100, 101, 102]), 200);
});

test('queries every provider in parallel and returns the median rate', async () => {
  const seen = [];
  const now = new Date();
  const make = (name, rate) => provider(name, async () => {
    seen.push(name);
    return { provider: name, rate: String(rate), fetchedAt: now, sourceTimestamp: now };
  });

  const quote = await fetchAggregatedRate({
    sourceCurrency: 'ngn',
    targetCurrency: 'usdc',
    providers: [make('exchange', 0.0006), make('coingecko', 0.0007), make('binance', 5)],
    now,
  });

  assert.deepEqual(seen.sort(), ['binance', 'coingecko', 'exchange']);
  assert.equal(quote.rate, '0.0007');
  assert.equal(quote.providerCount, 3);
  assert.equal(quote.stale, false);
  assert.equal(quote.sourceCurrency, 'NGN');
  assert.match(quote.provider, /^median:/);
});

test('falls back seamlessly when a provider fails', async () => {
  const now = new Date();
  const quote = await fetchAggregatedRate({
    sourceCurrency: 'USD',
    targetCurrency: 'EUR',
    providers: [
      provider('down', async () => { throw new Error('provider down'); }),
      provider('a', async () => ({ provider: 'a', rate: '0.9', fetchedAt: now, sourceTimestamp: now })),
      provider('b', async () => ({ provider: 'b', rate: '0.92', fetchedAt: now, sourceTimestamp: now })),
    ],
    now,
  });

  assert.equal(quote.rate, '0.91');
  assert.equal(quote.providerCount, 2);
});

test('rejects feeds older than the freshness window and alerts operators', async () => {
  const now = new Date('2026-11-24T12:00:00Z');
  const alerts = [];
  config.pricing.fxAlertWebhookUrl = 'https://ops.example/webhook';
  config.pricing.fxAlertCooldownMs = 0;

  const quote = await fetchAggregatedRate({
    sourceCurrency: 'NGN',
    targetCurrency: 'USDC',
    providers: [
      provider('fresh', async () => ({
        provider: 'fresh', rate: '0.00065', fetchedAt: now, sourceTimestamp: now,
      })),
      provider('stale', async () => ({
        provider: 'stale',
        rate: '0.00060',
        fetchedAt: new Date(now.getTime() - 120000),
        sourceTimestamp: new Date(now.getTime() - 120000),
      })),
    ],
    post: async (url, body) => { alerts.push(body); },
    now,
  });

  assert.equal(quote.rate, '0.00065');
  assert.equal(quote.providerCount, 1);
  assert.ok(alerts.some((alert) => alert.event === 'fx.stale_feed_rejected'));
});

test('rejects every stale feed instead of pricing from them', async () => {
  const now = new Date('2026-11-24T12:00:00Z');
  await assert.rejects(
    () => fetchAggregatedRate({
      sourceCurrency: 'NGN',
      targetCurrency: 'USDC',
      providers: [
        provider('stale', async () => ({
          provider: 'stale',
          rate: '0.0006',
          fetchedAt: new Date(now.getTime() - 61000),
          sourceTimestamp: new Date(now.getTime() - 61000),
        })),
      ],
      now,
    }),
    { code: FX_ERROR_CODES.NO_FRESH_RATE }
  );
});

test('opens a per-provider circuit and keeps serving from the remaining feeds', async () => {
  const now = new Date();
  let failingCalls = 0;
  const failing = provider('flaky', async () => {
    failingCalls += 1;
    throw new Error('timeout');
  });
  const healthy = provider('healthy', async () => ({
    provider: 'healthy', rate: '0.9', fetchedAt: now, sourceTimestamp: now,
  }));

  config.pricing.circuitThreshold = 1;
  const first = await fetchAggregatedRate({
    sourceCurrency: 'USD', targetCurrency: 'EUR', providers: [failing, healthy], now,
  });
  assert.equal(first.rate, '0.9');
  assert.equal(failingCalls, 1);

  const second = await fetchAggregatedRate({
    sourceCurrency: 'USD', targetCurrency: 'EUR', providers: [failing, healthy], now,
  });
  assert.equal(second.rate, '0.9');
  assert.equal(failingCalls, 1, 'open circuit must skip the failing provider');
});

test('raises FX_ALL_PROVIDERS_FAILED and serves a stale cached quote during a total outage', async () => {
  const now = new Date();
  const healthy = provider('healthy', async () => ({
    provider: 'healthy', rate: '0.8', fetchedAt: now, sourceTimestamp: now,
  }));
  const first = await fetchAggregatedRate({
    sourceCurrency: 'GBP', targetCurrency: 'USD', providers: [healthy], now,
  });
  assert.equal(first.rate, '0.8');

  config.pricing.circuitThreshold = 10;
  await assert.rejects(
    () => fetchAggregatedRate({
      sourceCurrency: 'AUD',
      targetCurrency: 'USD',
      providers: [provider('down', async () => { throw new Error('down'); })],
      now,
    }),
    { code: FX_ERROR_CODES.ALL_PROVIDERS_FAILED }
  );

  const fallback = await fetchAggregatedRate({
    sourceCurrency: 'GBP',
    targetCurrency: 'USD',
    providers: [provider('down', async () => { throw new Error('down'); })],
    now,
  });
  assert.equal(fallback.rate, '0.8');
  assert.equal(fallback.stale, true);
});

test('reports FX_OPEN_CIRCUIT when every provider circuit is open', async () => {
  config.pricing.circuitThreshold = 1;
  const failing = provider('down', async () => { throw new Error('unavailable'); });

  await assert.rejects(
    () => fetchAggregatedRate({ sourceCurrency: 'USD', targetCurrency: 'EUR', providers: [failing] }),
    (error) => error instanceof FxAggregatorError && error.code === FX_ERROR_CODES.ALL_PROVIDERS_FAILED
  );
  await assert.rejects(
    () => fetchAggregatedRate({ sourceCurrency: 'USD', targetCurrency: 'EUR', providers: [failing] }),
    { code: FX_ERROR_CODES.OPEN_CIRCUIT }
  );
});
