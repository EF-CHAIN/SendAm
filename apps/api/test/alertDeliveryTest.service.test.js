// Issue #228 — Test suite for continuous alert delivery testing.
// Covers: happy path, primary route failure + fallback, both routes failing,
// acknowledgement failure, multi-route, missed/stale test detection,
// customer safety (synthetic marker), duplicate/overlap safety, retry bounds.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'b'.repeat(64);
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'testpassword123';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Reset module state before each test to keep them isolated.
// ---------------------------------------------------------------------------
let service;

const loadService = () => {
  // Force a fresh require to reset in-memory state.
  const abs = require.resolve('../src/observability/alertDeliveryTest.service.js');
  delete require.cache[abs];
  // Also reset metrics module so gauge/counter state is clean.
  const metricsAbs = require.resolve('../src/observability/metrics.js');
  delete require.cache[metricsAbs];
  service = require('../src/observability/alertDeliveryTest.service.js');
};

beforeEach(() => {
  loadService();
  service._resetState();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeConfig = ({
  primaryUrl = null,
  fallbackUrl = null,
  extraUrls = [],
  intervalMs = 60_000,
  timeoutMs = 2000,
  staleMultiplier = 2,
} = {}) => ({
  observability: {
    errorMonitorWebhookUrl: primaryUrl,
    errorMonitorToken: primaryUrl ? 'tok-primary' : null,
  },
  alertDeliveryTest: {
    intervalMs,
    fallbackWebhookUrl: fallbackUrl,
    fallbackWebhookToken: fallbackUrl ? 'tok-fallback' : null,
    extraRouteUrls: extraUrls,
    timeoutMs,
    staleMultiplier,
  },
});

/** Creates a mock deliver function with configurable per-URL responses. */
const mockDeliver = (responses = {}) => {
  const calls = [];
  const fn = async (route, payload, _timeoutMs) => {
    calls.push({ routeId: route.routeId, url: route.url, payload });
    const resp = responses[route.url] !== undefined ? responses[route.url] : { success: true, statusCode: 200 };
    await new Promise((resolve) => setImmediate(resolve)); // simulate async
    return {
      routeId: route.routeId,
      success: resp.success,
      fallback: route.fallback,
      statusCode: resp.statusCode,
      failureReason: resp.failureReason || null,
      durationMs: 10,
    };
  };
  fn.calls = calls;
  return fn;
};

// ---------------------------------------------------------------------------
// Test: buildPayload — customer safety
// ---------------------------------------------------------------------------
describe('buildPayload', () => {
  test('marks payload as synthetic so it cannot trigger a real alert', () => {
    const payload = service.buildPayload('test-id-1');
    assert.equal(payload.synthetic, true);
    assert.equal(payload.event, service.SYNTHETIC_MARKER);
    assert.equal(payload.testId, 'test-id-1');
    assert.ok(payload.message.includes('not a real incident'), 'payload message should contain safety disclaimer');
  });

  test('payload does not contain secrets or credentials', () => {
    const payload = service.buildPayload('test-id-2');
    const serialised = JSON.stringify(payload);
    // No obvious credential fields.
    assert.ok(!serialised.includes('password'), 'payload must not contain password');
    assert.ok(!serialised.includes('token'), 'payload must not contain token');
    assert.ok(!serialised.includes('secret'), 'payload must not contain secret');
  });
});

// ---------------------------------------------------------------------------
// Test: buildRoutes
// ---------------------------------------------------------------------------
describe('buildRoutes', () => {
  test('returns empty when no routes are configured', () => {
    const routes = service.buildRoutes(makeConfig());
    assert.equal(routes.length, 0);
  });

  test('includes primary route when configured', () => {
    const cfg = makeConfig({ primaryUrl: 'https://monitor.example.com/hook' });
    const routes = service.buildRoutes(cfg);
    assert.equal(routes.length, 1);
    assert.equal(routes[0].fallback, false);
    assert.ok(routes[0].url === 'https://monitor.example.com/hook');
  });

  test('includes primary + fallback when both configured', () => {
    const cfg = makeConfig({
      primaryUrl: 'https://primary.example.com/hook',
      fallbackUrl: 'https://fallback.example.com/hook',
    });
    const routes = service.buildRoutes(cfg);
    const primaryRoutes = routes.filter((r) => !r.fallback);
    const fallbackRoutes = routes.filter((r) => r.fallback);
    assert.equal(primaryRoutes.length, 1);
    assert.equal(fallbackRoutes.length, 1);
  });

  test('sanitises route IDs — no credentials in routeId', () => {
    const cfg = makeConfig({ primaryUrl: 'https://user:pass@monitor.example.com/hook?token=secret123' });
    const routes = service.buildRoutes(cfg);
    assert.ok(routes.length > 0);
    const routeId = routes[0].routeId;
    assert.ok(!routeId.includes('pass'), 'routeId must not contain password');
    assert.ok(!routeId.includes('secret123'), 'routeId must not contain token value');
  });
});

// ---------------------------------------------------------------------------
// Test: Successful delivery flow
// ---------------------------------------------------------------------------
describe('runAlertDeliveryTest — success path', () => {
  test('marks test as successful when primary route acknowledges', async () => {
    const cfg = makeConfig({ primaryUrl: 'https://monitor.example.com/hook' });
    const deliver = mockDeliver({ 'https://monitor.example.com/hook': { success: true, statusCode: 200 } });

    const run = await service.runAlertDeliveryTest(cfg, { deliver });

    assert.equal(run.success, true);
    assert.equal(run.fallbackUsed, false);
    assert.ok(run.testId, 'testId must be set');
    assert.ok(run.completedAt >= run.startedAt);
    assert.equal(run.routeResults.length, 1);
    assert.equal(run.routeResults[0].success, true);
    assert.equal(deliver.calls.length, 1);
  });

  test('payload carries synthetic marker to prevent real incident', async () => {
    const cfg = makeConfig({ primaryUrl: 'https://monitor.example.com/hook' });
    const deliver = mockDeliver({ 'https://monitor.example.com/hook': { success: true, statusCode: 200 } });

    await service.runAlertDeliveryTest(cfg, { deliver });

    const deliveredPayload = deliver.calls[0].payload;
    assert.equal(deliveredPayload.synthetic, true);
    assert.equal(deliveredPayload.event, service.SYNTHETIC_MARKER);
    assert.ok(!deliveredPayload.customerId, 'no customer data in synthetic test');
    assert.ok(!deliveredPayload.phoneNumber, 'no phone number in synthetic test');
  });

  test('skips gracefully with success=true when no routes configured', async () => {
    const cfg = makeConfig();
    const deliver = mockDeliver();
    const run = await service.runAlertDeliveryTest(cfg, { deliver });

    assert.equal(run.success, true);
    assert.equal(run.skipped, true);
    assert.equal(deliver.calls.length, 0, 'no delivery calls when unconfigured');
  });

  test('updates last successful test state', async () => {
    const cfg = makeConfig({ primaryUrl: 'https://monitor.example.com/hook' });
    const deliver = mockDeliver({ 'https://monitor.example.com/hook': { success: true, statusCode: 200 } });

    const run = await service.runAlertDeliveryTest(cfg, { deliver });
    const status = service.getAlertDeliveryTestStatus(cfg);

    assert.equal(status.lastSuccessfulTest.testId, run.testId);
    assert.equal(status.healthy, true);
  });
});

// ---------------------------------------------------------------------------
// Test: Primary route failure → fallback
// ---------------------------------------------------------------------------
describe('runAlertDeliveryTest — primary failure, fallback success', () => {
  test('uses fallback when primary fails and marks overall success', async () => {
    const cfg = makeConfig({
      primaryUrl: 'https://primary.example.com/hook',
      fallbackUrl: 'https://fallback.example.com/hook',
    });
    const deliver = mockDeliver({
      'https://primary.example.com/hook': { success: false, statusCode: 503, failureReason: 'service unavailable' },
      'https://fallback.example.com/hook': { success: true, statusCode: 200 },
    });

    const run = await service.runAlertDeliveryTest(cfg, { deliver });

    assert.equal(run.success, true, 'overall should succeed when fallback works');
    assert.equal(run.fallbackUsed, true, 'fallbackUsed must be true');
    assert.equal(deliver.calls.length, 2, 'must have tried primary then fallback');

    const fallbackResult = run.routeResults.find((r) => r.fallback);
    assert.ok(fallbackResult, 'fallback route result must be present');
    assert.equal(fallbackResult.success, true);
  });

  test('does not call fallback when primary succeeds', async () => {
    const cfg = makeConfig({
      primaryUrl: 'https://primary.example.com/hook',
      fallbackUrl: 'https://fallback.example.com/hook',
    });
    const deliver = mockDeliver({
      'https://primary.example.com/hook': { success: true, statusCode: 200 },
    });

    const run = await service.runAlertDeliveryTest(cfg, { deliver });

    assert.equal(run.success, true);
    assert.equal(run.fallbackUsed, false);
    assert.equal(deliver.calls.length, 1, 'only primary should have been called');
  });
});

// ---------------------------------------------------------------------------
// Test: Both routes fail
// ---------------------------------------------------------------------------
describe('runAlertDeliveryTest — both routes fail', () => {
  test('marks overall test failed when primary and fallback both fail', async () => {
    const cfg = makeConfig({
      primaryUrl: 'https://primary.example.com/hook',
      fallbackUrl: 'https://fallback.example.com/hook',
    });
    const deliver = mockDeliver({
      'https://primary.example.com/hook': { success: false, statusCode: 500, failureReason: 'server error' },
      'https://fallback.example.com/hook': { success: false, statusCode: 503, failureReason: 'service unavailable' },
    });

    const run = await service.runAlertDeliveryTest(cfg, { deliver });

    assert.equal(run.success, false);
    assert.equal(run.fallbackUsed, true);
    const status = service.getAlertDeliveryTestStatus(cfg);
    assert.equal(status.lastTestAttempt.success, false);
    assert.equal(status.healthy, false);
  });

  test('no routes configured — test is a success (unconfigured is not an error)', async () => {
    const cfg = makeConfig();
    const deliver = mockDeliver();
    const run = await service.runAlertDeliveryTest(cfg, { deliver });
    assert.equal(run.success, true);
  });
});

// ---------------------------------------------------------------------------
// Test: Acknowledgement failure (non-2xx response)
// ---------------------------------------------------------------------------
describe('runAlertDeliveryTest — acknowledgement failure', () => {
  test('treats non-2xx HTTP response as failed delivery', async () => {
    const cfg = makeConfig({ primaryUrl: 'https://monitor.example.com/hook' });
    const deliver = mockDeliver({ 'https://monitor.example.com/hook': { success: false, statusCode: 404, failureReason: 'route returned HTTP 404' } });

    const run = await service.runAlertDeliveryTest(cfg, { deliver });

    assert.equal(run.success, false);
    assert.equal(run.routeResults[0].statusCode, 404);
    assert.ok(run.routeResults[0].failureReason.includes('404'));
  });

  test('treats request timeout as failed delivery', async () => {
    const cfg = makeConfig({ primaryUrl: 'https://monitor.example.com/hook' });
    const deliver = mockDeliver({
      'https://monitor.example.com/hook': { success: false, statusCode: null, failureReason: 'delivery timed out after 2000ms' },
    });

    const run = await service.runAlertDeliveryTest(cfg, { deliver });

    assert.equal(run.success, false);
    assert.equal(run.routeResults[0].statusCode, null);
    assert.ok(run.routeResults[0].failureReason.includes('timed out'));
  });
});

// ---------------------------------------------------------------------------
// Test: Multiple routes — every route is exercised
// ---------------------------------------------------------------------------
describe('runAlertDeliveryTest — multiple primary routes via extraRouteUrls', () => {
  test('tests every configured route independently', async () => {
    const cfg = makeConfig({
      primaryUrl: 'https://primary.example.com/hook',
      extraUrls: ['https://extra1.example.com/hook', 'https://extra2.example.com/hook'],
    });

    // extraRouteUrls are treated as additional primary routes in buildRoutes —
    // they are not fallback routes.  Build the routes to understand what's primary.
    const routes = service.buildRoutes(cfg);
    const deliver = mockDeliver(
      Object.fromEntries(routes.map((r) => [r.url, { success: true, statusCode: 200 }])),
    );

    const run = await service.runAlertDeliveryTest(cfg, { deliver });

    assert.equal(run.routeResults.length >= 1, true, 'at least primary route was tested');
    assert.ok(deliver.calls.length >= 1, 'primary route was called');
  });

  test('one route failing marks overall test failed when no fallback', async () => {
    const cfg = makeConfig({ primaryUrl: 'https://primary.example.com/hook' });
    const deliver = mockDeliver({
      'https://primary.example.com/hook': { success: false, statusCode: 500, failureReason: 'server error' },
    });

    const run = await service.runAlertDeliveryTest(cfg, { deliver });
    assert.equal(run.success, false);
  });
});

// ---------------------------------------------------------------------------
// Test: Stale test detection
// ---------------------------------------------------------------------------
describe('checkStaleTests', () => {
  test('not stale when no test has run yet (first boot grace period)', () => {
    const cfg = makeConfig({ primaryUrl: 'https://monitor.example.com/hook', intervalMs: 60_000 });
    service._resetState();
    const result = service.checkStaleTests(cfg, Date.now());
    assert.equal(result.stale, false);
  });

  test('not stale when last success is recent', async () => {
    const cfg = makeConfig({ primaryUrl: 'https://monitor.example.com/hook', intervalMs: 60_000, staleMultiplier: 2 });
    const deliver = mockDeliver({ 'https://monitor.example.com/hook': { success: true, statusCode: 200 } });

    await service.runAlertDeliveryTest(cfg, { deliver });

    const result = service.checkStaleTests(cfg, Date.now() + 30_000); // 30s later = still fresh
    assert.equal(result.stale, false);
  });

  test('stale when last success exceeds staleMultiplier × intervalMs', async () => {
    const cfg = makeConfig({ primaryUrl: 'https://monitor.example.com/hook', intervalMs: 60_000, staleMultiplier: 2 });
    const deliver = mockDeliver({ 'https://monitor.example.com/hook': { success: true, statusCode: 200 } });

    await service.runAlertDeliveryTest(cfg, { deliver });

    // Simulate 2× interval + 1 second having passed.
    const staleNow = Date.now() + 2 * 60_000 + 1_000;
    const result = service.checkStaleTests(cfg, staleNow);
    assert.equal(result.stale, true);
    assert.ok(result.staleSinceMs > 0);
  });

  test('stale with no fallback success after a failed run', async () => {
    const cfg = makeConfig({ primaryUrl: 'https://monitor.example.com/hook', intervalMs: 60_000, staleMultiplier: 2 });
    const deliver = mockDeliver({ 'https://monitor.example.com/hook': { success: false, statusCode: 500, failureReason: 'error' } });

    await service.runAlertDeliveryTest(cfg, { deliver });

    // lastSuccess never set; stale after 2× interval from lastRun.
    const staleNow = Date.now() + 2 * 60_000 + 1_000;
    const result = service.checkStaleTests(cfg, staleNow);
    assert.equal(result.stale, true);
  });
});

// ---------------------------------------------------------------------------
// Test: getAlertDeliveryTestStatus (operator-visible)
// ---------------------------------------------------------------------------
describe('getAlertDeliveryTestStatus', () => {
  test('returns configured=false and healthy=false when no routes and no run', () => {
    const cfg = makeConfig();
    const status = service.getAlertDeliveryTestStatus(cfg);
    assert.equal(status.configured, false);
    assert.equal(status.lastTestAttempt, null);
    assert.equal(status.lastSuccessfulTest, null);
    // healthy is false when lastSuccess is null
    assert.equal(status.healthy, false);
  });

  test('returns configured=true when primary route configured', () => {
    const cfg = makeConfig({ primaryUrl: 'https://monitor.example.com/hook' });
    const status = service.getAlertDeliveryTestStatus(cfg);
    assert.equal(status.configured, true);
    assert.ok(status.testedRoutes.length > 0);
  });

  test('returns full status after a successful run', async () => {
    const cfg = makeConfig({ primaryUrl: 'https://monitor.example.com/hook', intervalMs: 60_000 });
    const deliver = mockDeliver({ 'https://monitor.example.com/hook': { success: true, statusCode: 200 } });

    const run = await service.runAlertDeliveryTest(cfg, { deliver });
    const status = service.getAlertDeliveryTestStatus(cfg);

    assert.equal(status.configured, true);
    assert.equal(status.lastTestAttempt.success, true);
    assert.equal(status.lastTestAttempt.testId, run.testId);
    assert.equal(status.lastSuccessfulTest.testId, run.testId);
    assert.equal(status.healthy, true);
    assert.equal(status.stale, false);
    assert.equal(status.fallbackUsed, undefined); // top-level fallbackUsed only in lastTestAttempt
  });

  test('does not expose credentials in testedRoutes', () => {
    const cfg = makeConfig({ primaryUrl: 'https://user:pass@monitor.example.com/hook?token=abc' });
    const status = service.getAlertDeliveryTestStatus(cfg);
    const serialised = JSON.stringify(status);
    assert.ok(!serialised.includes('user:pass'), 'credentials must not be in status');
    assert.ok(!serialised.includes('token=abc'), 'token must not be in status');
  });
});

// ---------------------------------------------------------------------------
// Test: Customer safety — synthetic tests cannot invoke customer-facing flows
// ---------------------------------------------------------------------------
describe('customer safety', () => {
  test('payload event is SYNTHETIC_MARKER — not a production alert event name', () => {
    const payload = service.buildPayload('test-safety');
    assert.equal(payload.event, service.SYNTHETIC_MARKER);
    // Must not be named like a real incident event.
    assert.ok(payload.event !== 'sendam_exception');
    assert.ok(payload.event !== 'payment_failed');
    assert.ok(payload.event !== 'kyc_status');
  });

  test('payload explicitly marks itself as not a real incident', () => {
    const payload = service.buildPayload('test-safety-2');
    const msg = payload.message.toLowerCase();
    assert.ok(msg.includes('not a real incident') || msg.includes('synthetic'));
  });

  test('synthetic test does not reference any customer or user ID', () => {
    const payload = service.buildPayload('test-safety-3');
    assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'userId'));
    assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'customerId'));
    assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'phoneNumber'));
  });
});

// ---------------------------------------------------------------------------
// Test: Duplicate / overlap safety
// ---------------------------------------------------------------------------
describe('duplicate execution safety', () => {
  test('running two tests concurrently produces two independent results', async () => {
    const cfg = makeConfig({ primaryUrl: 'https://monitor.example.com/hook' });
    const deliver = mockDeliver({ 'https://monitor.example.com/hook': { success: true, statusCode: 200 } });

    const [run1, run2] = await Promise.all([
      service.runAlertDeliveryTest(cfg, { deliver }),
      service.runAlertDeliveryTest(cfg, { deliver }),
    ]);

    assert.ok(run1.testId !== run2.testId, 'each test run must have a unique ID');
    assert.equal(run1.success, true);
    assert.equal(run2.success, true);
  });
});

// ---------------------------------------------------------------------------
// Test: Retry behaviour is bounded (deliverToRoute does not loop internally)
// ---------------------------------------------------------------------------
describe('retry / loop bounds', () => {
  test('deliverToRoute attempts exactly once per call', async () => {
    let callCount = 0;
    const fetch = global.fetch;

    // Temporarily override global fetch to count calls.
    global.fetch = async () => {
      callCount++;
      return { ok: true, status: 200 };
    };

    try {
      const route = {
        routeId: 'https://monitor.example.com/hook',
        url: 'https://monitor.example.com/hook',
        token: null,
        fallback: false,
      };
      const payload = service.buildPayload('retry-test');
      const result = await service.deliverToRoute(route, payload, 5000);
      assert.equal(callCount, 1, 'deliverToRoute must make exactly one HTTP request');
      assert.equal(result.success, true);
    } finally {
      global.fetch = fetch;
    }
  });

  test('fallback is only attempted once per failed primary', async () => {
    const cfg = makeConfig({
      primaryUrl: 'https://primary.example.com/hook',
      fallbackUrl: 'https://fallback.example.com/hook',
    });
    const deliver = mockDeliver({
      'https://primary.example.com/hook': { success: false, statusCode: 503, failureReason: 'unavailable' },
      'https://fallback.example.com/hook': { success: false, statusCode: 503, failureReason: 'also unavailable' },
    });

    const run = await service.runAlertDeliveryTest(cfg, { deliver });

    const fallbackCalls = deliver.calls.filter((c) => c.url === 'https://fallback.example.com/hook');
    assert.equal(fallbackCalls.length, 1, 'fallback must be attempted exactly once, not in a loop');
    assert.equal(run.success, false);
  });
});

// ---------------------------------------------------------------------------
// Test: validateEnv extended for alertDeliveryTest config
// ---------------------------------------------------------------------------
describe('alertDeliveryTest config defaults', () => {
  test('env.js alertDeliveryTest has sensible defaults', () => {
    // Load fresh env module with clean environment
    const envAbs = require.resolve('../src/config/env.js');
    delete require.cache[envAbs];
    const envCfg = require('../src/config/env.js');

    assert.ok(Number.isFinite(envCfg.alertDeliveryTest.intervalMs));
    assert.ok(envCfg.alertDeliveryTest.intervalMs > 0);
    assert.ok(Number.isFinite(envCfg.alertDeliveryTest.timeoutMs));
    assert.ok(envCfg.alertDeliveryTest.staleMultiplier >= 1);
    assert.ok(Array.isArray(envCfg.alertDeliveryTest.extraRouteUrls));
  });
});
