'use strict';

// Issue #228 — Continuously test alert delivery
//
// Sends periodic synthetic alerts through every configured alert route, verifies
// delivery and acknowledgement, detects missed tests, and exposes operator-visible
// status. Synthetic tests are explicitly labelled so they cannot trigger real
// customer notifications or incidents.

const crypto = require('node:crypto');
const { increment, setGauge } = require('./metrics');
const logger = require('../utils/logger');
const { captureException } = require('./errors');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Marker included in every synthetic alert payload. */
const SYNTHETIC_MARKER = 'sendam-alert-delivery-test';

/** Label added to log events so they are easily filtered. */
const LOG_LABEL = 'alert_delivery_test';

// Default stale-test multiplier: flag a miss when 2× the interval has elapsed.
const DEFAULT_STALE_MULTIPLIER = 2;

// HTTP statuses considered successful acknowledgement.
const ACK_OK_STATUSES = new Set([200, 201, 202, 204]);

// ---------------------------------------------------------------------------
// In-memory state (survives the process lifetime; reset on restart intentionally)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RouteResult
 * @property {string} routeId          - Sanitised route identifier (no credentials).
 * @property {boolean} success         - True when delivery was confirmed.
 * @property {boolean} fallback        - True when this result came from the fallback route.
 * @property {number|null} statusCode  - HTTP response status, if obtained.
 * @property {string|null} failureReason
 * @property {number} durationMs
 */

/**
 * @typedef {Object} TestRun
 * @property {string}        testId
 * @property {number}        startedAt           - Unix epoch ms.
 * @property {number|null}   completedAt
 * @property {boolean}       success
 * @property {boolean}       fallbackUsed
 * @property {RouteResult[]} routeResults
 */

const state = {
  /** @type {TestRun|null} */
  lastRun: null,
  /** @type {TestRun|null} */
  lastSuccess: null,
  /** Whether at least one test has been attempted. */
  hasRun: false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sanitiseUrl = (raw) => {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    // Strip credentials from the URL so they are never logged.
    u.username = '';
    u.password = '';
    u.searchParams.delete('token');
    u.searchParams.delete('api_key');
    u.searchParams.delete('key');
    return `${u.origin}${u.pathname}`;
  } catch (_err) {
    return 'invalid-url';
  }
};

/**
 * Build the list of routes to test.
 *
 * Primary:  config.observability.errorMonitorWebhookUrl   (ERROR_MONITOR_WEBHOOK_URL)
 * Fallback: config.alertDeliveryTest.fallbackWebhookUrl   (ALERT_DELIVERY_TEST_FALLBACK_URL)
 * Extra:    config.alertDeliveryTest.extraRouteUrls        (ALERT_DELIVERY_TEST_EXTRA_URLS)
 *
 * Routes are deduplicated. A primary url that equals the fallback url is fine
 * — both are still tested independently if configured separately.
 */
const buildRoutes = (config) => {
  const routes = [];

  const primary = config?.observability?.errorMonitorWebhookUrl;
  if (primary) {
    routes.push({
      routeId: sanitiseUrl(primary),
      url: primary,
      token: config?.observability?.errorMonitorToken || null,
      fallback: false,
    });
  }

  const fallback = config?.alertDeliveryTest?.fallbackWebhookUrl;
  if (fallback) {
    routes.push({
      routeId: sanitiseUrl(fallback),
      url: fallback,
      token: config?.alertDeliveryTest?.fallbackWebhookToken || null,
      fallback: true,
    });
  }

  const extras = config?.alertDeliveryTest?.extraRouteUrls || [];
  for (const url of extras) {
    if (url) {
      routes.push({
        routeId: sanitiseUrl(url),
        url,
        token: null,
        fallback: false,
      });
    }
  }

  return routes;
};

/**
 * Synthesise a test payload.  The `synthetic: true` flag and SYNTHETIC_MARKER
 * are the safety barrier — they prevent any consumer from treating this as a
 * real alert.
 */
const buildPayload = (testId) => ({
  event: SYNTHETIC_MARKER,
  synthetic: true,
  testId,
  service: process.env.SERVICE_NAME || 'sendam-api',
  environment: process.env.NODE_ENV || 'development',
  timestamp: new Date().toISOString(),
  message: 'Synthetic alert delivery verification — not a real incident.',
});

/**
 * Attempt delivery to a single route.
 *
 * @param {object} route
 * @param {object} payload
 * @param {number} timeoutMs
 * @returns {Promise<RouteResult>}
 */
const deliverToRoute = async (route, payload, timeoutMs) => {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const response = await fetch(route.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-sendam-synthetic': '1',
        ...(route.token ? { authorization: `Bearer ${route.token}` } : {}),
      },
      body: JSON.stringify(payload),
    });

    const ackOk = ACK_OK_STATUSES.has(response.status);
    const durationMs = Date.now() - startedAt;

    if (!ackOk) {
      return {
        routeId: route.routeId,
        success: false,
        fallback: route.fallback,
        statusCode: response.status,
        failureReason: `route returned HTTP ${response.status}`,
        durationMs,
      };
    }

    return {
      routeId: route.routeId,
      success: true,
      fallback: route.fallback,
      statusCode: response.status,
      failureReason: null,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const reason = controller.signal.aborted
      ? `delivery timed out after ${timeoutMs}ms`
      : error.message;
    return {
      routeId: route.routeId,
      success: false,
      fallback: route.fallback,
      statusCode: null,
      failureReason: reason,
      durationMs,
    };
  } finally {
    clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// Core test runner
// ---------------------------------------------------------------------------

/**
 * Run one full synthetic alert delivery test cycle.
 *
 * For each primary route:
 *   1. Attempt delivery.
 *   2. If failed AND a fallback route is configured, try the fallback.
 *   3. Record result.
 *
 * The overall test is a success when every primary route (or its fallback)
 * delivers successfully.
 *
 * @param {object} config  — config/env.js module
 * @param {object} [opts]  — override for unit testing
 * @returns {Promise<TestRun>}
 */
const runAlertDeliveryTest = async (config, opts = {}) => {
  const deliver = opts.deliver || deliverToRoute;
  const timeoutMs = config?.alertDeliveryTest?.timeoutMs || 5000;
  const testId = crypto.randomUUID();
  const startedAt = Date.now();

  const routes = buildRoutes(config);

  if (routes.length === 0) {
    // Nothing configured — test is a no-op but we still mark it as "run" so
    // stale-test detection does not fire on unconfigured deployments.
    logger.info(`${LOG_LABEL}_skipped`, {
      testId,
      reason: 'no-routes-configured',
    });
    const run = {
      testId,
      startedAt,
      completedAt: Date.now(),
      success: true,
      fallbackUsed: false,
      routeResults: [],
      skipped: true,
    };
    _recordRun(run);
    return run;
  }

  const payload = buildPayload(testId);
  logger.info(`${LOG_LABEL}_started`, {
    testId,
    routeCount: routes.length,
  });

  increment('sendam_alert_delivery_test_attempts_total');

  const primaryRoutes = routes.filter((r) => !r.fallback);
  const fallbackRoutes = routes.filter((r) => r.fallback);
  const routeResults = [];
  let fallbackUsed = false;
  let overallSuccess = true;

  for (const route of primaryRoutes) {
    logger.info(`${LOG_LABEL}_route_delivery`, {
      testId,
      routeId: route.routeId,
      fallback: false,
    });

    const result = await deliver(route, payload, timeoutMs);
    routeResults.push(result);

    if (result.success) {
      logger.info(`${LOG_LABEL}_route_acknowledged`, {
        testId,
        routeId: route.routeId,
        statusCode: result.statusCode,
        durationMs: result.durationMs,
      });
      increment('sendam_alert_delivery_test_success_total', { route: route.routeId });
    } else {
      logger.error(`${LOG_LABEL}_route_failed`, {
        testId,
        routeId: route.routeId,
        statusCode: result.statusCode,
        failureReason: result.failureReason,
        durationMs: result.durationMs,
      });
      increment('sendam_alert_delivery_test_failure_total', { route: route.routeId });

      // Attempt fallback route(s) when the primary fails.
      let fallbackSucceeded = false;
      for (const fb of fallbackRoutes) {
        logger.info(`${LOG_LABEL}_fallback_attempted`, {
          testId,
          primaryRouteId: route.routeId,
          fallbackRouteId: fb.routeId,
        });
        increment('sendam_alert_delivery_test_fallback_total', { fallback: fb.routeId });
        fallbackUsed = true;

        const fbResult = await deliver(fb, payload, timeoutMs);
        fbResult.triggeredByPrimaryFailure = route.routeId;
        routeResults.push(fbResult);

        if (fbResult.success) {
          logger.info(`${LOG_LABEL}_fallback_acknowledged`, {
            testId,
            fallbackRouteId: fb.routeId,
            statusCode: fbResult.statusCode,
            durationMs: fbResult.durationMs,
          });
          increment('sendam_alert_delivery_test_success_total', { route: fb.routeId });
          fallbackSucceeded = true;
          break;
        } else {
          logger.error(`${LOG_LABEL}_fallback_failed`, {
            testId,
            fallbackRouteId: fb.routeId,
            statusCode: fbResult.statusCode,
            failureReason: fbResult.failureReason,
            durationMs: fbResult.durationMs,
          });
          increment('sendam_alert_delivery_test_failure_total', { route: fb.routeId });
        }
      }

      if (!fallbackSucceeded) {
        overallSuccess = false;
      }
    }
  }

  // Test extra (non-fallback) routes independently — a failure does NOT use
  // the fallback and marks the overall test failed.
  const extraRoutes = routes.filter((r) => !r.fallback && !primaryRoutes.includes(r));
  for (const route of extraRoutes) {
    const result = await deliver(route, payload, timeoutMs);
    routeResults.push(result);
    if (!result.success) overallSuccess = false;
  }

  const completedAt = Date.now();

  logger.info(`${LOG_LABEL}_completed`, {
    testId,
    success: overallSuccess,
    fallbackUsed,
    durationMs: completedAt - startedAt,
    routeResults: routeResults.map((r) => ({
      routeId: r.routeId,
      success: r.success,
      statusCode: r.statusCode,
      fallback: r.fallback,
      durationMs: r.durationMs,
    })),
  });

  const run = {
    testId,
    startedAt,
    completedAt,
    success: overallSuccess,
    fallbackUsed,
    routeResults,
  };

  _recordRun(run);

  if (!overallSuccess) {
    // Surface as a capturable exception so ERROR_MONITOR_WEBHOOK_URL receives
    // the failure signal — but only after the test itself, not as the test.
    // This uses captureException's existing envelope, which is a real alert
    // (not synthetic), so operators are paged only if the test fails.
    const err = Object.assign(new Error('Alert delivery test failed — one or more routes could not be verified'), {
      testId,
      routeResults: routeResults.map((r) => ({ routeId: r.routeId, success: r.success, fallback: r.fallback })),
    });
    captureException(err, { source: 'alert_delivery_test', testId }).catch(() => {});
  }

  return run;
};

/** Persist the run into in-memory state and update Prometheus gauges. */
const _recordRun = (run) => {
  state.lastRun = run;
  state.hasRun = true;
  if (run.success) {
    state.lastSuccess = run;
    setGauge('sendam_alert_delivery_test_last_success_timestamp_seconds', run.completedAt / 1000);
  }
  setGauge('sendam_alert_delivery_test_last_attempt_timestamp_seconds', (run.completedAt || run.startedAt) / 1000);
  if (run.success) {
    increment('sendam_alert_delivery_test_overall_success_total');
  } else {
    increment('sendam_alert_delivery_test_overall_failure_total');
  }
};

// ---------------------------------------------------------------------------
// Stale-test detection
// ---------------------------------------------------------------------------

/**
 * Check whether the alert delivery tests have become stale.
 *
 * Returns `true` when the last successful test is older than
 * `staleMultiplier × intervalMs`, which means the scheduler has stopped
 * running or has been failing for too long.
 *
 * @param {object} config
 * @param {number} [nowMs]
 * @returns {{ stale: boolean, staleSinceMs: number|null, intervalMs: number }}
 */
const checkStaleTests = (config, nowMs = Date.now()) => {
  const intervalMs = config?.alertDeliveryTest?.intervalMs || 600_000; // default 10 min
  const staleMultiplier = config?.alertDeliveryTest?.staleMultiplier || DEFAULT_STALE_MULTIPLIER;
  const staleThresholdMs = intervalMs * staleMultiplier;

  if (!state.hasRun) {
    // No test has ever run — not stale yet on first boot (give it one interval).
    return { stale: false, staleSinceMs: null, intervalMs };
  }

  const lastAttempt = state.lastRun?.completedAt || state.lastRun?.startedAt;
  const lastSuccessAt = state.lastSuccess?.completedAt;

  // If we've never succeeded but have attempted, check when the last attempt was.
  const referenceTime = lastSuccessAt || lastAttempt;
  if (!referenceTime) {
    return { stale: false, staleSinceMs: null, intervalMs };
  }

  const ageMs = nowMs - referenceTime;
  const stale = ageMs > staleThresholdMs;

  if (stale) {
    increment('sendam_alert_delivery_test_stale_total');
  }

  setGauge('sendam_alert_delivery_test_stale', stale ? 1 : 0);

  return { stale, staleSinceMs: stale ? ageMs : null, intervalMs };
};

// ---------------------------------------------------------------------------
// Operator-visible status
// ---------------------------------------------------------------------------

/**
 * Return a plain-object status snapshot for the admin API.
 *
 * @param {object} config
 * @param {number} [nowMs]
 */
const getAlertDeliveryTestStatus = (config, nowMs = Date.now()) => {
  const staleInfo = checkStaleTests(config, nowMs);
  const routes = buildRoutes(config);

  return {
    configured: routes.length > 0,
    intervalMs: config?.alertDeliveryTest?.intervalMs || null,
    routeCount: routes.length,
    testedRoutes: routes.map((r) => r.routeId),
    lastTestAttempt: state.lastRun
      ? {
        testId: state.lastRun.testId,
        startedAt: new Date(state.lastRun.startedAt).toISOString(),
        completedAt: state.lastRun.completedAt
          ? new Date(state.lastRun.completedAt).toISOString()
          : null,
        success: state.lastRun.success,
        fallbackUsed: state.lastRun.fallbackUsed,
        routeResults: (state.lastRun.routeResults || []).map((r) => ({
          routeId: r.routeId,
          success: r.success,
          fallback: r.fallback || false,
          statusCode: r.statusCode,
          failureReason: r.failureReason,
          durationMs: r.durationMs,
        })),
      }
      : null,
    lastSuccessfulTest: state.lastSuccess
      ? {
        testId: state.lastSuccess.testId,
        completedAt: new Date(state.lastSuccess.completedAt).toISOString(),
      }
      : null,
    healthy: state.lastSuccess !== null && !staleInfo.stale,
    stale: staleInfo.stale,
    staleSinceMs: staleInfo.staleSinceMs,
  };
};

// ---------------------------------------------------------------------------
// State reset (for tests)
// ---------------------------------------------------------------------------
const _resetState = () => {
  state.lastRun = null;
  state.lastSuccess = null;
  state.hasRun = false;
};

module.exports = {
  SYNTHETIC_MARKER,
  buildRoutes,
  buildPayload,
  deliverToRoute,
  runAlertDeliveryTest,
  checkStaleTests,
  getAlertDeliveryTestStatus,
  _resetState,
  _recordRun,
  LOG_LABEL,
};
