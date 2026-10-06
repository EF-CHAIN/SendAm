const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { captureException } = require('../src/observability/errors');
const { runWithContext } = require('../src/observability/context');
const { renderMetrics, resetMetrics } = require('../src/observability/metrics');

// ---------------------------------------------------------------------------
// Helper: temporarily replace global.fetch and restore it afterwards.
// ---------------------------------------------------------------------------
const withFetch = async (fakeFetch, fn) => {
  const originalFetch = global.fetch;
  global.fetch = fakeFetch;
  try {
    return await fn();
  } finally {
    global.fetch = originalFetch;
  }
};

// Reset metrics and alert-monitor env vars before each test to avoid
// cross-test interference.
beforeEach(() => {
  resetMetrics();
  delete process.env.ERROR_MONITOR_WEBHOOK_URL;
  delete process.env.ERROR_MONITOR_TOKEN;
  delete process.env.ERROR_MONITOR_TIMEOUT_MS;
});

// ---------------------------------------------------------------------------
// Happy path — correlated, redacted payload reaches the monitor endpoint.
// ---------------------------------------------------------------------------
test('exception reporter sends a correlated, redacted alert payload', async () => {
  let request;
  process.env.ERROR_MONITOR_WEBHOOK_URL = 'https://alerts.example.test/events';
  process.env.ERROR_MONITOR_TOKEN = 'alert-routing-token';

  const delivered = await withFetch(
    async (url, options) => {
      request = { url, options };
      return { ok: true };
    },
    () =>
      runWithContext({ correlationId: 'corr-error-1' }, () =>
        captureException(new Error('payment failed pin=1234'), {
          source: 'worker',
          apiToken: 'must-not-leak',
        }),
      ),
  );

  assert.equal(delivered, true);
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.context.correlationId, 'corr-error-1');
  assert.equal(payload.context.apiToken, '[REDACTED]');
  assert.doesNotMatch(request.options.body, /1234|must-not-leak/);
  assert.equal(request.options.headers.authorization, 'Bearer alert-routing-token');
});

// ---------------------------------------------------------------------------
// Unconfigured — degrades safely when no monitor URL is set.
// ---------------------------------------------------------------------------
test('exception reporter degrades safely when monitoring is unconfigured', async () => {
  // ERROR_MONITOR_WEBHOOK_URL already deleted in beforeEach.
  assert.equal(await captureException(new Error('test'), { source: 'test' }), false);
});

// ---------------------------------------------------------------------------
// Metric increment — every captureException call increments the counter,
// regardless of whether delivery succeeds or fails.
// ---------------------------------------------------------------------------
test('captureException increments sendam_exceptions_total on every call', async () => {
  resetMetrics();

  // First call: no monitor configured — delivery returns false but metric fires.
  await captureException(new Error('first'), { source: 'test' });

  // Second call: monitor configured, delivery succeeds.
  process.env.ERROR_MONITOR_WEBHOOK_URL = 'https://alerts.example.test/events';
  await withFetch(async () => ({ ok: true }), () =>
    captureException(new Error('second'), { source: 'test' }),
  );

  const metricsText = renderMetrics();
  // Both calls must be counted; the exact value may be higher than 2 if the
  // module-level counter has prior state, but we can assert the metric appears
  // and the counter value is at least 2.
  assert.match(metricsText, /sendam_exceptions_total/);
  const match = metricsText.match(/sendam_exceptions_total\{source="test"\}\s+(\d+)/);
  assert.ok(match, 'sendam_exceptions_total{source="test"} line not found in metrics output');
  assert.ok(Number(match[1]) >= 2, `expected at least 2 exceptions recorded, got ${match[1]}`);
});

// ---------------------------------------------------------------------------
// HTTP failure — monitor returns a non-2xx response.
// captureException must return false and not throw.
// ---------------------------------------------------------------------------
test('captureException returns false and does not throw when monitor returns non-2xx', async () => {
  process.env.ERROR_MONITOR_WEBHOOK_URL = 'https://alerts.example.test/events';

  const delivered = await withFetch(
    async () => ({ ok: false, status: 503 }),
    () => captureException(new Error('downstream alert error'), { source: 'test' }),
  );

  assert.equal(delivered, false);
});

// ---------------------------------------------------------------------------
// Network error — fetch rejects entirely (e.g. DNS failure, connection reset).
// captureException must return false and not throw.
// ---------------------------------------------------------------------------
test('captureException returns false and does not throw on network error', async () => {
  process.env.ERROR_MONITOR_WEBHOOK_URL = 'https://alerts.example.test/events';

  const delivered = await withFetch(
    async () => {
      throw new Error('ECONNREFUSED');
    },
    () => captureException(new Error('probe error'), { source: 'test' }),
  );

  assert.equal(delivered, false);
});

// ---------------------------------------------------------------------------
// Timeout — fetch hangs longer than ERROR_MONITOR_TIMEOUT_MS.
// The AbortController must cancel the request and captureException returns false.
// ---------------------------------------------------------------------------
test('captureException cancels a hung monitor request at the configured deadline', async () => {
  process.env.ERROR_MONITOR_WEBHOOK_URL = 'https://alerts.example.test/events';
  // 200 ms gives CI enough headroom; the test still completes in ~200 ms because
  // the fake fetch rejects as soon as the signal fires (no truly-hung promise).
  process.env.ERROR_MONITOR_TIMEOUT_MS = '200';

  const delivered = await withFetch(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        // If the signal has already fired by the time fetch() is called (e.g.
        // under heavy load), reject synchronously so the promise settles
        // immediately and the test runner is never left with a pending promise.
        if (options.signal.aborted) {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          return;
        }
        // Simulate a hung connection: only resolve once the AbortController
        // fires.  A real setTimeout keeps the Node.js event loop alive for the
        // duration so the test runner does not see a stalled microtask queue
        // and cancel the test with ERR_TEST_FAILURE / cancelledByParent.
        const tid = setTimeout(() => {}, 10_000);
        options.signal.addEventListener('abort', () => {
          clearTimeout(tid);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      }),
    () => captureException(new Error('slow monitor'), { source: 'test' }),
  );

  assert.equal(delivered, false);
});

// ---------------------------------------------------------------------------
// Production env validation — ERROR_MONITOR_WEBHOOK_URL must be set and
// must use HTTPS. The enforcement lives in validateEnv; these rules are
// covered comprehensively in validateEnv.test.js:
//   "production requires metrics authentication and error alert routing"
//   "production error monitor endpoint must use HTTPS"
// ---------------------------------------------------------------------------
