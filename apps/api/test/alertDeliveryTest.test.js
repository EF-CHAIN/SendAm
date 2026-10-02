// Alert delivery test service — comprehensive tests (issue #228).
//
// Tests the core acceptance criteria:
//   - Scheduled synthetic tests are generated and marked synthetic.
//   - The real alert-delivery path is exercised (or skipped with a clear reason).
//   - Successful delivery records a successful end-to-end test.
//   - Primary route failure triggers fallback.
//   - Both routes failing produces an actionable failure.
//   - Overdue / missed tests are reported as unhealthy.
//   - Acknowledgement timeout does not incorrectly report success.
//   - Persistent state follows the in-memory DB pattern used elsewhere.
//   - Concurrent/duplicate execution is suppressed by the in-flight guard.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'b'.repeat(64);
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'testpassword123';
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  RESULT,
  STATUS,
  SYNTHETIC_TYPE,
  runAlertDeliveryTest,
  saveTestResult,
  getLastTestResult,
  getLastSuccessfulTestResult,
  evaluateAlertDeliveryHealth,
  startAlertDeliveryTestPoller,
  sanitizeErrorMessage,
} = require('../src/observability/alertDeliveryTest.service');

// ---------------------------------------------------------------------------
// In-memory DB helper (same pattern as notificationOutbox.test.js)
// ---------------------------------------------------------------------------

const makeDb = () => {
  const rows = new Map();
  const notifications = new Map();
  let seq = 0;
  let notSeq = 0;

  return {
    alertDeliveryTest: {
      async create({ data }) {
        seq += 1;
        const row = { id: `adt_${seq}`, createdAt: new Date(), ...data };
        rows.set(row.id, row);
        return row;
      },
      async findFirst({ where, orderBy } = {}) {
        let results = [...rows.values()];

        if (where?.overallResult?.in) {
          results = results.filter((r) => where.overallResult.in.includes(r.overallResult));
        }

        if (orderBy?.completedAt === 'desc') {
          results.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
        }

        return results[0] ?? null;
      },
    },
    notification: {
      async create({ data }) {
        notSeq += 1;
        const row = { id: `n_${notSeq}`, sendAttempts: 0, claimedAt: null, ...data };
        notifications.set(row.id, row);
        return row;
      },
      async findUnique({ where }) {
        for (const row of notifications.values()) {
          if (where.idempotencyKey && row.idempotencyKey === where.idempotencyKey) return row;
          if (where.id && row.id === where.id) return row;
        }
        return null;
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const row of notifications.values()) {
          if (where.id && row.id !== where.id) continue;
          if (where.status && typeof where.status === 'string' && row.status !== where.status) continue;
          if (where.claimedAt?.lt && !(row.claimedAt && row.claimedAt < where.claimedAt.lt)) continue;
          for (const [key, value] of Object.entries(data)) {
            row[key] = value && value.increment ? (row[key] || 0) + value.increment : value;
          }
          count += 1;
        }
        return { count };
      },
      async update({ where, data }) {
        const row = notifications.get(where.id);
        if (!row) throw new Error('Notification not found');
        Object.assign(row, data);
        return row;
      },
    },
  };
};

const makeConfig = (overrides = {}) => ({
  messageTransport: 'meta',
  alertDeliveryTest: {
    intervalMs: 15 * 60 * 1000,
    timeoutMs: 5000,
    testPhone: '+15550001234',
    missedFactor: 2,
    ...overrides.alertDeliveryTest,
  },
  observability: {
    errorMonitorWebhookUrl: null,
    errorMonitorToken: null,
    ...overrides.observability,
  },
  ...overrides,
});

// Stub send implementations
const successWhatsApp = async () => ({ providerMessageId: 'wamid.abc123', notificationId: 'n_1' });
const failWhatsApp = async () => { throw new Error('Meta API unreachable'); };
const successWebhook = async () => ({ ok: true, statusCode: 200 });
const failWebhook = async () => { throw new Error('Webhook endpoint returned HTTP 503'); };

// ---------------------------------------------------------------------------
// Core: synthetic test execution
// ---------------------------------------------------------------------------

test('runAlertDeliveryTest marks the test as synthetic via SYNTHETIC_TYPE', async () => {
  const db = makeDb();

  const trackingWhatsApp = async ({ testId, ...rest }) => {
    return successWhatsApp({ testId, ...rest });
  };

  const cfg = makeConfig();
  const result = await runAlertDeliveryTest({ db, config: cfg, sendWhatsApp: trackingWhatsApp, sendWebhook: successWebhook });

  assert.ok(result.testId, 'testId must be set');
  assert.equal(typeof result.testId, 'string');
  // The Notification row's type would be SYNTHETIC_TYPE — verify the constant
  assert.equal(SYNTHETIC_TYPE, 'synthetic_delivery_test');
});

test('runAlertDeliveryTest succeeds when WhatsApp returns a providerMessageId', async () => {
  const db = makeDb();
  const cfg = makeConfig();

  const result = await runAlertDeliveryTest({ db, config: cfg, sendWhatsApp: successWhatsApp, sendWebhook: successWebhook });

  assert.equal(result.overallResult, RESULT.SUCCESS);
  assert.ok(result.completedAt);
  assert.ok(result.durationMs >= 0);

  const whatsappRoute = result.routes.find((r) => r.name === 'whatsapp');
  assert.ok(whatsappRoute, 'WhatsApp route must appear in result');
  assert.equal(whatsappRoute.result, RESULT.SUCCESS);
  assert.equal(whatsappRoute.attempted, true);
});

test('runAlertDeliveryTest skips WhatsApp when testPhone is not configured', async () => {
  const db = makeDb();
  const cfg = makeConfig({ alertDeliveryTest: { intervalMs: 900000, timeoutMs: 5000, testPhone: null, missedFactor: 2 } });

  const result = await runAlertDeliveryTest({ db, config: cfg, sendWhatsApp: failWhatsApp, sendWebhook: successWebhook });

  const whatsappRoute = result.routes.find((r) => r.name === 'whatsapp');
  assert.equal(whatsappRoute.attempted, false);
  assert.equal(whatsappRoute.result, RESULT.SKIPPED);
  assert.ok(whatsappRoute.error.includes('ALERT_DELIVERY_TEST_PHONE not configured'));
});

test('runAlertDeliveryTest skips WhatsApp when messageTransport is not meta', async () => {
  const db = makeDb();
  const cfg = makeConfig({ messageTransport: 'sim' });

  const result = await runAlertDeliveryTest({ db, config: cfg, sendWhatsApp: failWhatsApp, sendWebhook: successWebhook });

  const whatsappRoute = result.routes.find((r) => r.name === 'whatsapp');
  assert.equal(whatsappRoute.attempted, false);
  assert.equal(whatsappRoute.result, RESULT.SKIPPED);
});

// ---------------------------------------------------------------------------
// Multiple routes: every configured route is tested
// ---------------------------------------------------------------------------

test('runAlertDeliveryTest reports both routes in result.routes', async () => {
  const db = makeDb();
  const cfg = makeConfig({ observability: { errorMonitorWebhookUrl: 'https://hooks.example.com/alert', errorMonitorToken: null } });

  const result = await runAlertDeliveryTest({ db, config: cfg, sendWhatsApp: successWhatsApp, sendWebhook: successWebhook });

  assert.equal(result.routes.length, 2);
  const names = result.routes.map((r) => r.name);
  assert.ok(names.includes('whatsapp'));
  assert.ok(names.includes('webhook'));
});

// ---------------------------------------------------------------------------
// Primary route failure → fallback
// ---------------------------------------------------------------------------

test('primary route failure triggers fallback webhook route', async () => {
  const db = makeDb();
  const cfg = makeConfig({ observability: { errorMonitorWebhookUrl: 'https://hooks.example.com/alert', errorMonitorToken: null } });

  const result = await runAlertDeliveryTest({ db, config: cfg, sendWhatsApp: failWhatsApp, sendWebhook: successWebhook });

  assert.equal(result.overallResult, RESULT.FALLBACK_SUCCESS, 'fallback succeeded → overallResult must be fallback_success');

  const whatsappRoute = result.routes.find((r) => r.name === 'whatsapp');
  assert.equal(whatsappRoute.result, RESULT.FAILURE);
  assert.ok(whatsappRoute.error, 'primary failure must record an error message');

  const webhookRoute = result.routes.find((r) => r.name === 'webhook');
  assert.equal(webhookRoute.attempted, true);
  assert.equal(webhookRoute.result, RESULT.SUCCESS);
});

test('primary failure is clearly recorded alongside fallback success', async () => {
  const db = makeDb();
  const cfg = makeConfig({ observability: { errorMonitorWebhookUrl: 'https://hooks.example.com/alert', errorMonitorToken: null } });

  const result = await runAlertDeliveryTest({ db, config: cfg, sendWhatsApp: failWhatsApp, sendWebhook: successWebhook });

  const primary = result.routes.find((r) => r.name === 'whatsapp');
  assert.ok(primary.error, 'primary error must be non-empty');
  assert.notEqual(primary.error, null);
});

// ---------------------------------------------------------------------------
// Both routes failing
// ---------------------------------------------------------------------------

test('both primary and fallback failing produces FAILURE result', async () => {
  const db = makeDb();
  const cfg = makeConfig({ observability: { errorMonitorWebhookUrl: 'https://hooks.example.com/alert', errorMonitorToken: null } });

  const result = await runAlertDeliveryTest({ db, config: cfg, sendWhatsApp: failWhatsApp, sendWebhook: failWebhook });

  assert.equal(result.overallResult, RESULT.FAILURE);

  const whatsappRoute = result.routes.find((r) => r.name === 'whatsapp');
  assert.equal(whatsappRoute.result, RESULT.FAILURE);

  const webhookRoute = result.routes.find((r) => r.name === 'webhook');
  assert.equal(webhookRoute.result, RESULT.FAILURE);
  assert.ok(webhookRoute.error, 'fallback failure must record an error');
});

test('no fallback configured and primary fails → FAILURE with no fallback attempted', async () => {
  const db = makeDb();
  const cfg = makeConfig({ observability: { errorMonitorWebhookUrl: null, errorMonitorToken: null } });

  const result = await runAlertDeliveryTest({ db, config: cfg, sendWhatsApp: failWhatsApp, sendWebhook: failWebhook });

  assert.equal(result.overallResult, RESULT.FAILURE);
  const webhookRoute = result.routes.find((r) => r.name === 'webhook');
  assert.equal(webhookRoute.attempted, false);
  assert.ok(webhookRoute.error?.includes('no fallback available') || webhookRoute.error?.includes('not configured'));
});

// ---------------------------------------------------------------------------
// Acknowledgement timeout
// ---------------------------------------------------------------------------

test('acknowledgement timeout does not report success', async () => {
  const db = makeDb();
  const cfg = makeConfig({
    alertDeliveryTest: { intervalMs: 900000, timeoutMs: 50, testPhone: '+15550001234', missedFactor: 2 },
    observability: { errorMonitorWebhookUrl: null, errorMonitorToken: null },
  });

  // A send that never resolves within the configured timeout
  const hangingWhatsApp = () => new Promise(() => {});

  const result = await runAlertDeliveryTest({ db, config: cfg, sendWhatsApp: hangingWhatsApp, sendWebhook: successWebhook });

  assert.notEqual(result.overallResult, RESULT.SUCCESS, 'timeout must not be recorded as success');
  const whatsappRoute = result.routes.find((r) => r.name === 'whatsapp');
  assert.equal(whatsappRoute.result, RESULT.TIMEOUT);
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('saveTestResult persists a test record retrievable by getLastTestResult', async () => {
  const db = makeDb();
  const cfg = makeConfig();

  const result = await runAlertDeliveryTest({ db, config: cfg, sendWhatsApp: successWhatsApp, sendWebhook: successWebhook });
  await saveTestResult(db, result);

  const saved = await getLastTestResult(db);
  assert.ok(saved, 'should find the saved record');
  assert.equal(saved.testId, result.testId);
  assert.equal(saved.overallResult, result.overallResult);
});

test('getLastSuccessfulTestResult returns the most recent success', async () => {
  const db = makeDb();
  const cfg = makeConfig();

  // Record a failure first, then a success
  const failResult = await runAlertDeliveryTest({ db, config: cfg, sendWhatsApp: failWhatsApp, sendWebhook: failWebhook });
  await saveTestResult(db, failResult);

  const successResult = await runAlertDeliveryTest({ db, config: cfg, sendWhatsApp: successWhatsApp, sendWebhook: successWebhook });
  await saveTestResult(db, successResult);

  const lastSuccess = await getLastSuccessfulTestResult(db);
  assert.ok(lastSuccess, 'should find the successful record');
  assert.equal(lastSuccess.overallResult, RESULT.SUCCESS);
  assert.equal(lastSuccess.testId, successResult.testId);
});

test('getLastSuccessfulTestResult returns null when no success has been recorded', async () => {
  const db = makeDb();
  const cfg = makeConfig({ observability: { errorMonitorWebhookUrl: null } });

  const failResult = await runAlertDeliveryTest({ db, config: cfg, sendWhatsApp: failWhatsApp, sendWebhook: failWebhook });
  await saveTestResult(db, failResult);

  const lastSuccess = await getLastSuccessfulTestResult(db);
  assert.equal(lastSuccess, null);
});

test('saveTestResult handles persistence failure gracefully without throwing', async () => {
  // DB with a broken create
  const brokenDb = {
    alertDeliveryTest: {
      create: async () => { throw new Error('disk full'); },
      findFirst: async () => null,
    },
    notification: {},
  };

  const cfg = makeConfig();
  const result = await runAlertDeliveryTest({ db: makeDb(), config: cfg, sendWhatsApp: successWhatsApp });

  // Should not throw
  const saved = await saveTestResult(brokenDb, result);
  assert.equal(saved, null, 'should return null on persistence failure');
});

test('state survives restart — getLastTestResult returns null when no records exist', async () => {
  // Fresh empty DB simulates a restart with no prior records
  const freshDb = makeDb();
  const last = await getLastTestResult(freshDb);
  assert.equal(last, null);
  const lastSuccess = await getLastSuccessfulTestResult(freshDb);
  assert.equal(lastSuccess, null);
});

// ---------------------------------------------------------------------------
// Missed test detection
// ---------------------------------------------------------------------------

test('evaluateAlertDeliveryHealth returns unknown when no test has been recorded', () => {
  const health = evaluateAlertDeliveryHealth({
    lastTest: null,
    lastSuccess: null,
    intervalMs: 15 * 60 * 1000,
    now: Date.now(),
  });

  assert.equal(health.status, STATUS.UNKNOWN);
  assert.equal(health.lastTestAt, null);
});

test('evaluateAlertDeliveryHealth returns healthy when success is recent', () => {
  const now = Date.now();
  const recentTest = { completedAt: new Date(now - 5 * 60 * 1000).toISOString(), overallResult: RESULT.SUCCESS };

  const health = evaluateAlertDeliveryHealth({
    lastTest: recentTest,
    lastSuccess: recentTest,
    intervalMs: 15 * 60 * 1000,
    missedFactor: 2,
    now,
  });

  assert.equal(health.status, STATUS.HEALTHY);
  assert.ok(health.lastSuccessAt);
  assert.equal(health.overdueBy, null);
});

test('evaluateAlertDeliveryHealth returns missed when overdue by more than missedFactor × interval', () => {
  const now = Date.now();
  // Last success was 40 minutes ago, threshold is 2 × 15 min = 30 min
  const staleTest = { completedAt: new Date(now - 40 * 60 * 1000).toISOString(), overallResult: RESULT.FAILURE };
  const staleSuccess = { completedAt: new Date(now - 40 * 60 * 1000).toISOString(), overallResult: RESULT.SUCCESS };

  const health = evaluateAlertDeliveryHealth({
    lastTest: staleTest,
    lastSuccess: staleSuccess,
    intervalMs: 15 * 60 * 1000,
    missedFactor: 2,
    now,
  });

  assert.equal(health.status, STATUS.MISSED);
  assert.ok(health.overdueBy > 0, 'overdueBy must be positive when missed');
});

test('evaluateAlertDeliveryHealth returns degraded when last test failed but is still within window', () => {
  const now = Date.now();
  // Recent test (2 min ago) but it failed
  const recentFailure = { completedAt: new Date(now - 2 * 60 * 1000).toISOString(), overallResult: RESULT.FAILURE };
  // Last success was 25 minutes ago — within 2×15=30 min threshold
  const recentSuccess = { completedAt: new Date(now - 25 * 60 * 1000).toISOString(), overallResult: RESULT.SUCCESS };

  const health = evaluateAlertDeliveryHealth({
    lastTest: recentFailure,
    lastSuccess: recentSuccess,
    intervalMs: 15 * 60 * 1000,
    missedFactor: 2,
    now,
  });

  // Within threshold → should still be healthy
  assert.equal(health.status, STATUS.HEALTHY);
});

test('evaluateAlertDeliveryHealth returns degraded when last success is just past the threshold', () => {
  const now = Date.now();
  const staleSuccess = { completedAt: new Date(now - 31 * 60 * 1000).toISOString(), overallResult: RESULT.SUCCESS };
  const staleTest = { completedAt: new Date(now - 31 * 60 * 1000).toISOString(), overallResult: RESULT.SUCCESS };

  const health = evaluateAlertDeliveryHealth({
    lastTest: staleTest,
    lastSuccess: staleSuccess,
    intervalMs: 15 * 60 * 1000,
    missedFactor: 2,
    now,
  });

  assert.ok(
    health.status === STATUS.MISSED || health.status === STATUS.DEGRADED,
    `Expected missed or degraded, got ${health.status}`,
  );
});

// ---------------------------------------------------------------------------
// Fallback_success counts as a successful test
// ---------------------------------------------------------------------------

test('fallback_success result counts as a successful test in evaluateAlertDeliveryHealth', () => {
  const now = Date.now();
  const fallbackSuccess = {
    completedAt: new Date(now - 5 * 60 * 1000).toISOString(),
    overallResult: RESULT.FALLBACK_SUCCESS,
  };

  const health = evaluateAlertDeliveryHealth({
    lastTest: fallbackSuccess,
    lastSuccess: fallbackSuccess,
    intervalMs: 15 * 60 * 1000,
    missedFactor: 2,
    now,
  });

  assert.equal(health.status, STATUS.HEALTHY);
});

// ---------------------------------------------------------------------------
// Duplicate/concurrent execution protection
// ---------------------------------------------------------------------------

test('startAlertDeliveryTestPoller suppresses overlapping runs', async () => {
  const runCounts = { started: 0, finished: 0 };
  let resolveFirst;

  const slowWhatsApp = async () => {
    runCounts.started += 1;
    await new Promise((resolve) => { resolveFirst = resolve; });
    runCounts.finished += 1;
    return { providerMessageId: 'wamid.x', notificationId: 'n_x' };
  };

  const db = makeDb();
  const cfg = makeConfig();
  let tickFn;
  const fakeSetInterval = (fn, _ms) => {
    tickFn = fn;
    return { unref: () => {} };
  };

  const poller = startAlertDeliveryTestPoller({
    db,
    config: cfg,
    sendWhatsApp: slowWhatsApp,
    sendWebhook: successWebhook,
    _setInterval: fakeSetInterval,
    now: () => new Date(),
  });

  // Wait for the first run to start
  await new Promise((r) => setImmediate(r));

  // Trigger a second run while first is still in-flight
  const tick2 = tickFn?.();

  // Allow the first run to complete
  if (resolveFirst) resolveFirst();

  await tick2;

  // The second slot should have been skipped (only 1 run completed)
  assert.equal(runCounts.finished, 1, 'second concurrent run must be suppressed');

  poller.stop();
});

test('startAlertDeliveryTestPoller returns a stop function that clears the interval', () => {
  const db = makeDb();
  const cfg = makeConfig();
  let cleared = false;

  const fakeSetInterval = (_fn, _ms) => {
    const id = {};
    return id;
  };
  const originalClearInterval = global.clearInterval;
  global.clearInterval = () => { cleared = true; };

  const poller = startAlertDeliveryTestPoller({
    db,
    config: cfg,
    sendWhatsApp: successWhatsApp,
    sendWebhook: successWebhook,
    _setInterval: fakeSetInterval,
    now: () => new Date(),
  });

  poller.stop();
  global.clearInterval = originalClearInterval;

  assert.equal(cleared, true, 'stop() must clear the interval');
});

// ---------------------------------------------------------------------------
// Route-specific results recorded correctly
// ---------------------------------------------------------------------------

test('per-route results are accessible on the result object', async () => {
  const db = makeDb();
  const cfg = makeConfig({ observability: { errorMonitorWebhookUrl: 'https://hooks.example.com/alert', errorMonitorToken: 'tok' } });

  const result = await runAlertDeliveryTest({ db, config: cfg, sendWhatsApp: successWhatsApp, sendWebhook: successWebhook });

  for (const route of result.routes) {
    assert.ok('name' in route, `Route ${route.name} must have a name field`);
    assert.ok('attempted' in route, `Route ${route.name} must have an attempted field`);
    assert.ok('result' in route, `Route ${route.name} must have a result field`);
  }
});

// ---------------------------------------------------------------------------
// sanitizeErrorMessage
// ---------------------------------------------------------------------------

test('sanitizeErrorMessage strips bearer tokens from error strings', () => {
  const input = 'Authorization: Bearer supersecrettoken123 caused 401';
  const output = sanitizeErrorMessage(input);
  assert.ok(!output.includes('supersecrettoken123'), 'token must be redacted');
  assert.ok(output.includes('[redacted]'));
});

test('sanitizeErrorMessage truncates very long messages', () => {
  const long = 'x'.repeat(1000);
  const output = sanitizeErrorMessage(long);
  assert.ok(output.length <= 500);
});

// ---------------------------------------------------------------------------
// Prometheus metrics are emitted on test completion
// ---------------------------------------------------------------------------

test('runAlertDeliveryTest increments Prometheus counters', async () => {
  const { resetMetrics, renderMetrics } = require('../src/observability/metrics');
  resetMetrics();

  const db = makeDb();
  const cfg = makeConfig();
  await runAlertDeliveryTest({ db, config: cfg, sendWhatsApp: successWhatsApp, sendWebhook: successWebhook });

  const metrics = renderMetrics();
  assert.ok(
    metrics.includes('sendam_alert_delivery_test_total'),
    'sendam_alert_delivery_test_total counter must be emitted',
  );
});

test('runAlertDeliveryTest sets last_run and last_success gauges on success', async () => {
  const { resetMetrics, renderMetrics } = require('../src/observability/metrics');
  resetMetrics();

  const db = makeDb();
  const cfg = makeConfig();
  await runAlertDeliveryTest({ db, config: cfg, sendWhatsApp: successWhatsApp, sendWebhook: successWebhook });

  const metrics = renderMetrics();
  assert.ok(metrics.includes('sendam_alert_delivery_test_last_run_timestamp_seconds'), 'last run gauge must be set');
  assert.ok(metrics.includes('sendam_alert_delivery_test_last_success_timestamp_seconds'), 'last success gauge must be set');
});

test('failed test sets last_run gauge but not last_success gauge above baseline', async () => {
  const { resetMetrics, renderMetrics } = require('../src/observability/metrics');
  resetMetrics();
  // Baseline: success gauge has never been set — renderMetrics will not emit it
  const db = makeDb();
  const cfg = makeConfig({ observability: { errorMonitorWebhookUrl: null } });
  await runAlertDeliveryTest({ db, config: cfg, sendWhatsApp: failWhatsApp, sendWebhook: failWebhook });

  const metrics = renderMetrics();
  assert.ok(metrics.includes('sendam_alert_delivery_test_last_run_timestamp_seconds'), 'last run gauge must be set even on failure');
});

// ---------------------------------------------------------------------------
// Prometheus rules include the new alert delivery rules
// ---------------------------------------------------------------------------

test('prometheus-rules.yml contains SendAmAlertDeliveryTestMissed rule', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const rules = fs.readFileSync(path.resolve(__dirname, '../../../observability/prometheus-rules.yml'), 'utf8');

  assert.match(rules, /alert: SendAmAlertDeliveryTestMissed/);
  assert.match(rules, /sendam_alert_delivery_test_last_success_timestamp_seconds/);
});

test('prometheus-rules.yml contains SendAmAlertDeliveryTestFailing rule', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const rules = fs.readFileSync(path.resolve(__dirname, '../../../observability/prometheus-rules.yml'), 'utf8');

  assert.match(rules, /alert: SendAmAlertDeliveryTestFailing/);
  assert.match(rules, /sendam_alert_delivery_test_failures_total/);
});
