'use strict';

/**
 * Service-level objectives per scenario, and the pass/fail evaluation.
 *
 * These are budgets, not predictions: a run that comes in under them is
 * acceptable, and a run that breaches one is a regression to investigate
 * before shipping. Every number is annotated with the reasoning that produced
 * it so a future maintainer can argue with the reasoning rather than guess at
 * the intent. Re-derive them on real hardware (see docs/LOAD-TESTING.md) —
 * the defaults are sized for the documented reference environment.
 */

/**
 * The webhook path is the one Meta itself measures. Meta retries an event that
 * is not acknowledged quickly and will mark a webhook unhealthy if that keeps
 * happening, so the acknowledgement budget is set well inside Meta's tolerance
 * rather than at the edge of it. The endpoint only claims idempotency and
 * enqueues, so p99 is dominated by one INSERT plus one Redis round trip.
 */
const BUDGETS = {
  'webhook-burst': {
    description: 'Meta webhook delivery burst — signature check, dedup claim, enqueue.',
    // Reference measurement (see docs/LOAD-TESTING.md): p95 24ms, p99 53ms,
    // 1634 rps at the knee. Ceilings are ~4x the measured p99 and the floor is
    // ~25% of measured throughput, so slower hardware passes while a real
    // regression does not hide inside the headroom.
    maxP95Ms: 100,
    maxP99Ms: 250,
    maxErrorRate: 0.001,
    minThroughputRps: 400,
  },
  'sender-sequence': {
    description: 'One sender issuing a realistic message sequence, exercising per-sender rate limiting.',
    // Measured: p95 22ms, p99 31ms, 1594 rps.
    maxP95Ms: 100,
    maxP99Ms: 200,
    // Per-sender throttling deliberately drops excess messages, so this
    // scenario tolerates a higher non-2xx share by design.
    maxErrorRate: 0.02,
    minThroughputRps: 400,
  },
  'duplicate-storm': {
    description: 'Concurrent redelivery of one message id — the financial idempotency invariant.',
    // Measured: p95 71ms, p99 203ms, 699 rps — visibly worse than the other
    // webhook scenarios because every virtual user contends on the same
    // ProcessedMessage rows. That contention is the feature working; the
    // budget is set from the measurement rather than from the healthy case.
    maxP95Ms: 300,
    maxP99Ms: 800,
    maxErrorRate: 0.0,
    minThroughputRps: 150,
  },
  'payment-confirmation': {
    description: 'Transfer confirmation — the leg that debits a wallet and submits to Stellar.',
    // Measured: p95 50ms, p99 77ms, 765 rps. Two webhook round trips plus the
    // payment write, so roughly half the throughput of a bare webhook ack.
    maxP95Ms: 250,
    maxP99Ms: 500,
    maxErrorRate: 0.0,
    minThroughputRps: 150,
  },
  'deposit-sweep': {
    description: 'Wallet reads competing with the deposit poller sweep.',
    // Measured: p95 292ms, p99 783ms, 163 rps — an order of magnitude slower
    // than every other read because the balance path reaches Horizon. The
    // budget covers this service's share; a slow upstream surfaces as an
    // accepted 502/503 rather than as latency this service can fix.
    maxP95Ms: 1000,
    maxP99Ms: 2500,
    maxErrorRate: 0.01,
    minThroughputRps: 25,
  },
  'admin-read': {
    description: 'Admin dashboard reads — the heaviest database queries in the product.',
    // Measured: p95 22ms, p99 33ms, 1570 rps against a small dataset. Re-run
    // against production-shaped volumes before trusting this one; aggregate
    // queries are the numbers most sensitive to row count.
    maxP95Ms: 100,
    maxP99Ms: 200,
    maxErrorRate: 0.001,
    minThroughputRps: 300,
  },
  'health-read': {
    description: 'Liveness path, including its database round trip. The floor for all other numbers.',
    // Measured: p95 6ms, p99 12ms, 8576 rps.
    maxP95Ms: 50,
    maxP99Ms: 100,
    maxErrorRate: 0.0,
    minThroughputRps: 1000,
  },
};

/**
 * Queue lag budget. Applied only when a Redis URL is configured — without it
 * the harness cannot observe the queue and reports lag as unmeasured rather
 * than as zero, which would be a false pass.
 */
const QUEUE_BUDGET = {
  maxDepth: 500,
  maxOldestJobAgeMs: 30000,
};

/**
 * Scenarios whose work continues on a queue after the HTTP response. For these
 * an unmeasured queue is a failed run, not a skipped check — see `evaluate`.
 */
const QUEUE_BACKED_SCENARIOS = new Set(['webhook-burst', 'sender-sequence', 'duplicate-storm', 'payment-confirmation']);

/**
 * Scenarios where the database is the resource under test, so a run that could
 * not observe connection use has not established what it claims to.
 */
const RESOURCE_REQUIRED_SCENARIOS = new Set(['payment-confirmation', 'deposit-sweep', 'admin-read']);

/**
 * Headroom ceilings. Connection utilisation is the one that bites first: the
 * pool saturates long before memory does, and a saturated pool presents as
 * slow queries rather than as an obvious resource error.
 */
const RESOURCE_BUDGET = {
  maxConnectionUtilisation: 0.8,
  maxPeakMemoryMb: 1024,
};

/**
 * Share of responses that must be 429 before we call the run rate-limited
 * rather than merely erroring. Well above the handful a correctly configured
 * environment produces, well below a run that hit the wall immediately.
 */
const RATE_LIMITED_SHARE = 0.5;

/**
 * Detects the most common way a load run produces meaningless numbers: the
 * environment's own request rate limiter answering almost everything with 429.
 * Latency stays beautiful because rejecting a request is cheap, so without
 * this the report shows a fast, "healthy" service that never did any work.
 */
const detectRateLimitWall = (summary) => {
  const total = summary.requests;
  if (total === 0) return null;
  const rateLimited = summary.statusCounts?.['429'] || summary.statusCounts?.[429] || 0;
  if (rateLimited / total < RATE_LIMITED_SHARE) return null;
  return {
    share: Math.round((rateLimited / total) * 1000) / 1000,
    advice: 'the environment under test rate-limited this run — raise RATE_LIMIT_MAX / '
      + 'RATE_LIMIT_WINDOW_MIN there, or the numbers describe the limiter rather than the service',
  };
};

const evaluate = (scenarioName, summary, queueLag, resources) => {
  const budget = BUDGETS[scenarioName];
  if (!budget) return { scenario: scenarioName, passed: true, checks: [], unbudgeted: true };

  const checks = [];
  const check = (name, actual, limit, comparator, unit) => {
    const passed = actual === null ? true : comparator(actual, limit);
    checks.push({ name, actual, limit, unit, passed, skipped: actual === null });
  };

  const atMost = (actual, limit) => actual <= limit;
  const atLeast = (actual, limit) => actual >= limit;

  check('p95 latency', summary.latencyMs.p95, budget.maxP95Ms, atMost, 'ms');
  check('p99 latency', summary.latencyMs.p99, budget.maxP99Ms, atMost, 'ms');
  check('error rate', summary.errorRate, budget.maxErrorRate, atMost, 'fraction');
  check('throughput', summary.throughputRps, budget.minThroughputRps, atLeast, 'rps');

  if (queueLag?.measured) {
    check('queue depth', queueLag.depth, QUEUE_BUDGET.maxDepth, atMost, 'jobs');
    check('oldest job age', queueLag.oldestJobAgeMs, QUEUE_BUDGET.maxOldestJobAgeMs, atMost, 'ms');
  } else if (QUEUE_BACKED_SCENARIOS.has(scenarioName)) {
    // These scenarios acknowledge at the edge and finish the work on a queue.
    // Reporting a pass on their HTTP numbers alone would certify a service
    // whose backlog was never looked at, so an unmeasured queue is a failure
    // rather than a skipped check.
    checks.push({
      name: 'queue lag',
      actual: null,
      limit: null,
      unit: null,
      passed: false,
      skipped: false,
      reason: queueLag?.reason || 'queue lag was not measured',
    });
  }

  // Resource limits are a ceiling check, not a latency one: a run can meet
  // every latency budget while sitting at the edge of the connection pool.
  if (resources?.connections?.measured && resources.connections.utilisation !== null) {
    check('db connection use', resources.connections.utilisation, RESOURCE_BUDGET.maxConnectionUtilisation, atMost, 'fraction');
  } else if (RESOURCE_REQUIRED_SCENARIOS.has(scenarioName)) {
    checks.push({
      name: 'db connections',
      actual: null,
      limit: null,
      unit: null,
      passed: false,
      skipped: false,
      reason: resources?.connections?.reason || 'database connections were not measured',
    });
  }

  if (resources?.memory?.measured) {
    check('peak memory', resources.memory.peakMb, RESOURCE_BUDGET.maxPeakMemoryMb, atMost, 'MB');
  }

  const rateLimited = detectRateLimitWall(summary);
  if (rateLimited) {
    checks.push({
      name: 'rate limit wall',
      actual: null,
      limit: null,
      unit: null,
      passed: false,
      skipped: false,
      reason: `${Math.round(rateLimited.share * 100)}% of responses were 429 — ${rateLimited.advice}`,
    });
  }

  return {
    scenario: scenarioName,
    description: budget.description,
    passed: checks.every((c) => c.passed),
    rateLimited,
    checks,
  };
};

module.exports = {
  BUDGETS,
  QUEUE_BUDGET,
  RESOURCE_BUDGET,
  QUEUE_BACKED_SCENARIOS,
  RESOURCE_REQUIRED_SCENARIOS,
  detectRateLimitWall,
  evaluate,
};
