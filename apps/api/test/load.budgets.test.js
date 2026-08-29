const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluate,
  BUDGETS,
  QUEUE_BUDGET,
  RESOURCE_BUDGET,
  QUEUE_BACKED_SCENARIOS,
  detectRateLimitWall,
} = require('../load/lib/budgets');

const summaryWith = (overrides = {}) => ({
  requests: 1000,
  ok: 1000,
  failed: 0,
  errorRate: 0,
  throughputRps: 2000,
  latencyMs: { min: 1, p50: 10, p95: 30, p99: 60, max: 200 },
  statusCounts: { 200: 1000 },
  errorsByReason: {},
  ...overrides,
});

const healthyQueue = { measured: true, depth: 0, oldestJobAgeMs: 0 };
const healthyResources = {
  connections: { measured: true, utilisation: 0.2, peakTotal: 20, maxConnections: 100 },
  memory: { measured: true, peakMb: 300 },
};

test('a run inside every budget passes', () => {
  const result = evaluate('webhook-burst', summaryWith(), healthyQueue, healthyResources);
  assert.equal(result.passed, true);
  assert.ok(result.checks.every((c) => c.passed));
});

test('a p99 breach fails the run and names the offending check', () => {
  const result = evaluate('webhook-burst', summaryWith({
    latencyMs: { min: 1, p50: 10, p95: 30, p99: 9000, max: 9000 },
  }), healthyQueue, healthyResources);
  assert.equal(result.passed, false);
  const failed = result.checks.filter((c) => !c.passed).map((c) => c.name);
  assert.deepEqual(failed, ['p99 latency']);
});

test('throughput is a floor, not a ceiling', () => {
  const tooSlow = evaluate('webhook-burst', summaryWith({ throughputRps: 1 }), healthyQueue, healthyResources);
  assert.equal(tooSlow.passed, false);

  const fast = evaluate('webhook-burst', summaryWith({ throughputRps: 50000 }), healthyQueue, healthyResources);
  assert.equal(fast.passed, true);
});

test('an error rate above budget fails even when latency looks healthy', () => {
  const result = evaluate('webhook-burst', summaryWith({ errorRate: 0.05, failed: 50 }), healthyQueue, healthyResources);
  assert.equal(result.passed, false);
  assert.ok(result.checks.find((c) => c.name === 'error rate' && !c.passed));
});

test('duplicate-storm tolerates no errors at all', () => {
  // Idempotency contention must never surface as a failed request.
  assert.equal(BUDGETS['duplicate-storm'].maxErrorRate, 0);
  const result = evaluate('duplicate-storm', summaryWith({ errorRate: 0.001, failed: 1 }), healthyQueue, healthyResources);
  assert.equal(result.passed, false);
});

test('an unmeasured queue fails a queue-backed scenario rather than being skipped', () => {
  // Passing a webhook run whose backlog was never looked at would certify a
  // service that may be arbitrarily far behind.
  const unmeasured = evaluate(
    'webhook-burst',
    summaryWith(),
    { measured: false, reason: 'no REDIS_URL' },
    healthyResources,
  );
  assert.equal(unmeasured.passed, false);
  const check = unmeasured.checks.find((c) => c.name === 'queue lag');
  assert.equal(check.passed, false);
  assert.match(check.reason, /REDIS_URL/);
});

test('an unmeasured queue does not fail a scenario that does not use one', () => {
  const result = evaluate(
    'health-read',
    summaryWith(),
    { measured: false, reason: 'no REDIS_URL' },
    healthyResources,
  );
  assert.ok(!result.checks.some((c) => c.name === 'queue lag'));
  assert.equal(result.passed, true);
});

test('a breaching queue depth fails the run', () => {
  const breaching = evaluate('webhook-burst', summaryWith(), {
    measured: true,
    depth: QUEUE_BUDGET.maxDepth + 1,
    oldestJobAgeMs: 0,
  }, healthyResources);
  assert.equal(breaching.passed, false);
  assert.ok(breaching.checks.find((c) => c.name === 'queue depth' && !c.passed));
});

test('unmeasured database connections fail a database-bound scenario', () => {
  const result = evaluate('admin-read', summaryWith(), healthyQueue, {
    connections: { measured: false, reason: 'DATABASE_URL not set' },
    memory: { measured: false, reason: 'no token' },
  });
  assert.equal(result.passed, false);
  assert.ok(result.checks.find((c) => c.name === 'db connections' && !c.passed));
});

test('connection utilisation above the ceiling fails even when latency is fine', () => {
  const result = evaluate('admin-read', summaryWith(), healthyQueue, {
    connections: {
      measured: true,
      utilisation: RESOURCE_BUDGET.maxConnectionUtilisation + 0.1,
      peakTotal: 90,
      maxConnections: 100,
    },
    memory: { measured: true, peakMb: 300 },
  });
  assert.equal(result.passed, false);
  assert.ok(result.checks.find((c) => c.name === 'db connection use' && !c.passed));
});

test('a 429 flood is reported as a rate-limit wall, not as healthy latency', () => {
  // Rejecting a request is cheap, so a rate-limited run looks fast. Without
  // this detection the report would show excellent percentiles for a run that
  // never reached the service.
  const summary = summaryWith({
    requests: 1000,
    failed: 990,
    errorRate: 0.99,
    statusCounts: { 200: 10, 429: 990 },
  });
  const result = evaluate('admin-read', summary, healthyQueue, healthyResources);
  assert.equal(result.passed, false);
  assert.ok(result.rateLimited, 'the wall is detected');
  assert.ok(result.checks.find((c) => c.name === 'rate limit wall' && !c.passed));
});

test('a handful of 429s is not treated as a rate-limit wall', () => {
  const summary = summaryWith({ requests: 1000, statusCounts: { 200: 990, 429: 10 } });
  assert.equal(detectRateLimitWall(summary), null);
});

test('every queue-backed scenario has a budget', () => {
  for (const name of QUEUE_BACKED_SCENARIOS) {
    assert.ok(BUDGETS[name], `${name} must have a budget`);
  }
});

test('an unmeasured percentile is skipped rather than counted as a pass at zero', () => {
  const result = evaluate('webhook-burst', summaryWith({
    latencyMs: { min: null, p50: null, p95: null, p99: null, max: null },
  }), healthyQueue, healthyResources);
  const p95 = result.checks.find((c) => c.name === 'p95 latency');
  assert.equal(p95.skipped, true);
});

test('every scenario budget defines all four core limits', () => {
  for (const [name, budget] of Object.entries(BUDGETS)) {
    for (const key of ['maxP95Ms', 'maxP99Ms', 'maxErrorRate', 'minThroughputRps']) {
      assert.equal(typeof budget[key], 'number', `${name}.${key}`);
    }
    assert.ok(budget.description, `${name} documents what it covers`);
  }
});
