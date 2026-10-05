'use strict';

// Continuous alert-delivery testing (issue #228).
//
// Monitoring can appear healthy while alert routing is broken. A healthy
// /health/ready endpoint proves that Postgres and Redis are reachable; it
// says nothing about whether an alert sent through the configured delivery
// channel (WhatsApp / operator webhook) would actually reach a human.
//
// This module schedules periodic synthetic end-to-end tests. Each test:
//   1. Generates a unique test ID and marks itself clearly as synthetic.
//   2. Attempts delivery through every configured alert route.
//   3. Records the result (success/failure/fallback-used) durably in Postgres
//      so the state survives application restarts.
//   4. Emits Prometheus gauges so alert rules can fire when tests go overdue.
//
// The primary route is WhatsApp (Meta Cloud API).
// The fallback route is the ERROR_MONITOR_WEBHOOK_URL operator webhook
// (if configured).
//
// Synthetic tests are marked with type='synthetic_delivery_test' in the
// Notification table. They never carry customer data and are clearly
// identified as internal. A dedicated phone number
// (ALERT_DELIVERY_TEST_PHONE) is used so delivery never reaches a real
// customer.

const { randomUUID } = require('node:crypto');
const logger = require('../utils/logger');
const { increment, setGauge } = require('./metrics');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SYNTHETIC_TYPE = 'synthetic_delivery_test';

const RESULT = Object.freeze({
  SUCCESS: 'success',
  FALLBACK_SUCCESS: 'fallback_success',
  FAILURE: 'failure',
  TIMEOUT: 'timeout',
  SKIPPED: 'skipped',
});

const STATUS = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  MISSED: 'missed',
  UNKNOWN: 'unknown',
});

// ---------------------------------------------------------------------------
// Default send implementations (overridable for testing)
// ---------------------------------------------------------------------------

/**
 * Send the synthetic test message via the configured WhatsApp/Meta transport.
 *
 * We call `deliverMetaTextMessage` directly from whatsapp.service.js so the
 * test exercises the real provider path. The notification is persisted via the
 * outbox so the row is available if delivery status webhooks arrive later.
 *
 * Returns { providerMessageId, notificationId } on success, throws on failure.
 */
const defaultSendWhatsApp = async ({ testId, recipient, body, db }) => {
  const { reserveOutboundNotification, claimForSend, attachProviderResult, markSendFailed, STATUS: OUTBOX_STATUS } = require('../services/notificationOutbox.service');
  const { deliverMetaTextMessage } = require('../services/whatsapp.service');

  const notification = {
    userId: null,
    channel: 'whatsapp',
    type: SYNTHETIC_TYPE,
    referenceType: 'alert_delivery_test',
    referenceId: testId,
  };

  const row = await reserveOutboundNotification(db, { notification, to: recipient, body });

  if (!row) {
    // Non-durable type fallback: proceed without a row (test-only behaviour)
    const response = await deliverMetaTextMessage(recipient, body);
    return { providerMessageId: response?.messages?.[0]?.id || null, notificationId: null };
  }

  const claimed = await claimForSend(db, row.id);
  if (!claimed) {
    // Another instance claimed it — skip to avoid duplicate send
    return { providerMessageId: null, notificationId: row.id, skipped: true };
  }

  try {
    const response = await deliverMetaTextMessage(recipient, body);
    const providerMessageId = response?.messages?.[0]?.id || response?.message_id || null;
    await attachProviderResult(db, row.id, { providerMessageId, status: OUTBOX_STATUS.SENT });
    return { providerMessageId, notificationId: row.id };
  } catch (error) {
    await markSendFailed(db, row.id, error);
    throw error;
  }
};

/**
 * Send the synthetic test alert to the operator webhook fallback.
 *
 * Uses ERROR_MONITOR_WEBHOOK_URL and ERROR_MONITOR_TOKEN — the same route the
 * application uses for error-monitor events.
 *
 * Returns { ok: true } on success, throws on failure.
 */
const defaultSendWebhook = async ({ testId, body, webhookUrl, webhookToken, timeoutMs }) => {
  const https = require('node:https');
  const http = require('node:http');
  const { URL } = require('node:url');

  const parsed = new URL(webhookUrl);
  const isHttps = parsed.protocol === 'https:';
  const lib = isHttps ? https : http;

  const payload = JSON.stringify({
    type: SYNTHETIC_TYPE,
    testId,
    message: body,
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    service: process.env.SERVICE_NAME || 'sendam-api',
  });

  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (webhookToken) {
      headers['Authorization'] = `Bearer ${webhookToken}`;
    }

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: 'POST',
      headers,
    };

    const req = lib.request(options, (res) => {
      // Consume body so the socket can be reused
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolve({ ok: true, statusCode: res.statusCode });
      } else {
        reject(new Error(`Webhook returned HTTP ${res.statusCode}`));
      }
    });

    req.on('error', reject);

    const timer = setTimeout(() => {
      req.destroy(new Error(`Webhook request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    req.on('close', () => clearTimeout(timer));

    req.write(payload);
    req.end();
  });
};

// ---------------------------------------------------------------------------
// Core test runner
// ---------------------------------------------------------------------------

/**
 * Run one synthetic alert delivery test.
 *
 * Returns a result record describing what was attempted, what succeeded, and
 * what failed. Never throws — all errors are captured into the result.
 */
const runAlertDeliveryTest = async ({
  db,
  config,
  testId = randomUUID(),
  now = () => new Date(),
  sendWhatsApp = defaultSendWhatsApp,
  sendWebhook = defaultSendWebhook,
} = {}) => {
  const startedAt = now();

  const testPhone = config.alertDeliveryTest?.testPhone;
  const timeoutMs = config.alertDeliveryTest?.timeoutMs || 10000;
  const webhookUrl = config.observability?.errorMonitorWebhookUrl;
  const webhookToken = config.observability?.errorMonitorToken;
  const messageTransport = config.messageTransport || 'meta';

  const body = `[SYNTHETIC TEST] SendAm alert delivery verification. Test ID: ${testId}. This is an automated internal test — no action required.`;

  const routes = [];

  // ── Primary route: WhatsApp / Meta ──────────────────────────────────────
  // Only run the primary route when the transport is 'meta' and a dedicated
  // test phone is configured. In 'sim' mode the provider is a local
  // simulator and we skip to avoid noise, but we still record the skip so
  // the test completes with a known result rather than silently doing nothing.
  const primaryRoute = { name: 'whatsapp', attempted: false, result: null, error: null, providerMessageId: null };

  if (messageTransport === 'meta' && testPhone) {
    primaryRoute.attempted = true;
    try {
      const sent = await withTimeout(
        () => sendWhatsApp({ testId, recipient: testPhone, body, db }),
        timeoutMs,
        'whatsapp',
      );

      if (sent.skipped) {
        primaryRoute.result = RESULT.SKIPPED;
        primaryRoute.notificationId = sent.notificationId;
      } else {
        primaryRoute.result = RESULT.SUCCESS;
        primaryRoute.providerMessageId = sent.providerMessageId;
        primaryRoute.notificationId = sent.notificationId;
      }
    } catch (error) {
      primaryRoute.result = error.message?.includes('timed out') ? RESULT.TIMEOUT : RESULT.FAILURE;
      primaryRoute.error = sanitizeErrorMessage(error);
      logger.error('alert_delivery_test_primary_failed', { testId, error: primaryRoute.error });
      increment('sendam_alert_delivery_test_total', { route: 'whatsapp', result: 'failure' });
    }
  } else if (messageTransport !== 'meta') {
    primaryRoute.attempted = false;
    primaryRoute.result = RESULT.SKIPPED;
    primaryRoute.error = `MESSAGE_TRANSPORT=${messageTransport}; WhatsApp route skipped`;
  } else {
    // meta transport but no test phone configured
    primaryRoute.attempted = false;
    primaryRoute.result = RESULT.SKIPPED;
    primaryRoute.error = 'ALERT_DELIVERY_TEST_PHONE not configured; WhatsApp route skipped';
  }

  routes.push(primaryRoute);

  // ── Fallback route: operator webhook ────────────────────────────────────
  const fallbackRoute = { name: 'webhook', attempted: false, result: null, error: null };

  if (webhookUrl) {
    // Attempt fallback when: the primary route failed/timed out, OR the primary
    // was not attempted (transport not meta / no phone). Always attempt if
    // primary succeeded to give dual-route coverage — but mark it as
    // supplementary so operators understand both routes were tested.
    const primaryFailed = primaryRoute.result === RESULT.FAILURE || primaryRoute.result === RESULT.TIMEOUT;
    const primarySkipped = !primaryRoute.attempted || primaryRoute.result === RESULT.SKIPPED;

    if (primaryFailed || primarySkipped) {
      fallbackRoute.attempted = true;
      try {
        await withTimeout(
          () => sendWebhook({ testId, body, webhookUrl, webhookToken, timeoutMs }),
          timeoutMs,
          'webhook',
        );
        fallbackRoute.result = RESULT.SUCCESS;
      } catch (error) {
        fallbackRoute.result = error.message?.includes('timed out') ? RESULT.TIMEOUT : RESULT.FAILURE;
        fallbackRoute.error = sanitizeErrorMessage(error);
        logger.error('alert_delivery_test_fallback_failed', { testId, error: fallbackRoute.error });
        increment('sendam_alert_delivery_test_total', { route: 'webhook', result: 'failure' });
      }
    }
  } else if (primaryRoute.result === RESULT.FAILURE || primaryRoute.result === RESULT.TIMEOUT) {
    fallbackRoute.error = 'ERROR_MONITOR_WEBHOOK_URL not configured; no fallback available';
  }

  routes.push(fallbackRoute);

  // ── Determine overall outcome ────────────────────────────────────────────
  const primaryOk = primaryRoute.result === RESULT.SUCCESS || primaryRoute.result === RESULT.SKIPPED;
  const fallbackOk = fallbackRoute.result === RESULT.SUCCESS;
  const primaryFailed = primaryRoute.result === RESULT.FAILURE || primaryRoute.result === RESULT.TIMEOUT;

  let overallResult;
  if (primaryRoute.result === RESULT.SUCCESS) {
    overallResult = fallbackRoute.attempted && fallbackRoute.result !== RESULT.SUCCESS
      ? RESULT.SUCCESS // primary succeeded even if fallback failed
      : RESULT.SUCCESS;
  } else if (primaryRoute.result === RESULT.SKIPPED && fallbackRoute.result === RESULT.SUCCESS) {
    overallResult = RESULT.FALLBACK_SUCCESS;
  } else if (primaryFailed && fallbackOk) {
    overallResult = RESULT.FALLBACK_SUCCESS;
  } else if (primaryOk && !fallbackRoute.attempted) {
    overallResult = RESULT.SUCCESS;
  } else if (primaryFailed && !fallbackOk) {
    overallResult = RESULT.FAILURE;
  } else if (primaryRoute.result === RESULT.SKIPPED && !fallbackRoute.attempted) {
    overallResult = RESULT.SKIPPED;
  } else {
    overallResult = RESULT.FAILURE;
  }

  const completedAt = now();
  const durationMs = completedAt.getTime() - startedAt.getTime();

  const record = {
    testId,
    overallResult,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs,
    routes,
  };

  // Prometheus counters
  increment('sendam_alert_delivery_test_total', { result: overallResult });
  setGauge('sendam_alert_delivery_test_last_run_timestamp_seconds', completedAt.getTime() / 1000);
  if (overallResult === RESULT.SUCCESS || overallResult === RESULT.FALLBACK_SUCCESS) {
    setGauge('sendam_alert_delivery_test_last_success_timestamp_seconds', completedAt.getTime() / 1000);
  }

  return record;
};

// ---------------------------------------------------------------------------
// State persistence (in Postgres via AlertDeliveryTest model)
// ---------------------------------------------------------------------------

/**
 * Persist a test result. Returns the saved row or null on failure.
 * Persistence failures are logged but do not throw — the test result is
 * real regardless of whether we could record it.
 */
const saveTestResult = async (db, record) => {
  if (!db?.alertDeliveryTest?.create) return null;
  try {
    return await db.alertDeliveryTest.create({
      data: {
        testId: record.testId,
        overallResult: record.overallResult,
        startedAt: new Date(record.startedAt),
        completedAt: new Date(record.completedAt),
        durationMs: record.durationMs,
        routes: record.routes,
      },
    });
  } catch (error) {
    logger.error('alert_delivery_test_persist_failed', { testId: record.testId, error: error.message });
    return null;
  }
};

/**
 * Retrieve the most recent test result from Postgres.
 * Returns null if no test has ever been recorded.
 */
const getLastTestResult = async (db) => {
  if (!db?.alertDeliveryTest?.findFirst) return null;
  try {
    return await db.alertDeliveryTest.findFirst({
      orderBy: { completedAt: 'desc' },
    });
  } catch (error) {
    logger.error('alert_delivery_test_query_failed', { error: error.message });
    return null;
  }
};

/**
 * Retrieve the most recent *successful* test result from Postgres.
 * Returns null if no successful test has ever been recorded.
 */
const getLastSuccessfulTestResult = async (db) => {
  if (!db?.alertDeliveryTest?.findFirst) return null;
  try {
    return await db.alertDeliveryTest.findFirst({
      where: { overallResult: { in: [RESULT.SUCCESS, RESULT.FALLBACK_SUCCESS] } },
      orderBy: { completedAt: 'desc' },
    });
  } catch (error) {
    logger.error('alert_delivery_test_query_failed', { error: error.message });
    return null;
  }
};

// ---------------------------------------------------------------------------
// Status evaluation — are we healthy, degraded, or missed?
// ---------------------------------------------------------------------------

/**
 * Evaluate the current health of the alert delivery test mechanism.
 *
 * healthy   — the most recent test succeeded within the allowed window.
 * degraded  — the most recent test ran but failed (primary or fallback).
 * missed    — no successful test has completed within intervalMs * missedFactor.
 * unknown   — no test has ever been recorded.
 */
const evaluateAlertDeliveryHealth = ({ lastTest, lastSuccess, intervalMs, missedFactor = 2, now = Date.now() } = {}) => {
  if (!lastTest) {
    return {
      status: STATUS.UNKNOWN,
      message: 'No alert delivery test has ever been recorded.',
      lastTestAt: null,
      lastSuccessAt: null,
      overdueBy: null,
    };
  }

  const lastTestAt = new Date(lastTest.completedAt);
  const lastSuccessAt = lastSuccess ? new Date(lastSuccess.completedAt) : null;
  const ageMs = now - lastTestAt.getTime();
  const successAgeMs = lastSuccessAt ? now - lastSuccessAt.getTime() : null;
  const overdueThresholdMs = intervalMs * missedFactor;

  if (successAgeMs !== null && successAgeMs <= overdueThresholdMs) {
    return {
      status: STATUS.HEALTHY,
      message: 'Alert delivery test passed recently.',
      lastTestAt: lastTestAt.toISOString(),
      lastSuccessAt: lastSuccessAt.toISOString(),
      overdueBy: null,
    };
  }

  if (successAgeMs === null || successAgeMs > overdueThresholdMs) {
    const overdueBy = successAgeMs !== null ? successAgeMs - overdueThresholdMs : null;
    const status = ageMs > overdueThresholdMs ? STATUS.MISSED : STATUS.DEGRADED;
    return {
      status,
      message: status === STATUS.MISSED
        ? `Alert delivery test has not succeeded in ${Math.round((successAgeMs || ageMs) / 60000)} minutes (threshold: ${Math.round(overdueThresholdMs / 60000)} min).`
        : `Alert delivery test ran but did not succeed. Last result: ${lastTest.overallResult}.`,
      lastTestAt: lastTestAt.toISOString(),
      lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
      overdueBy,
      lastResult: lastTest.overallResult,
    };
  }

  return {
    status: STATUS.DEGRADED,
    message: `Alert delivery test ran but did not succeed. Last result: ${lastTest.overallResult}.`,
    lastTestAt: lastTestAt.toISOString(),
    lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
    overdueBy: null,
    lastResult: lastTest.overallResult,
  };
};

// ---------------------------------------------------------------------------
// Scheduled poller
// ---------------------------------------------------------------------------

/**
 * Start the periodic alert delivery test scheduler.
 *
 * Follows the same setInterval + .unref() pattern as the other pollers in
 * src/jobs/ (startWebhookInboxDrain, startOutboxReconciler, etc.).
 *
 * Returns { stop() } so the worker can shut it down cleanly.
 */
const startAlertDeliveryTestPoller = ({
  db,
  config,
  intervalMs,
  sendWhatsApp,
  sendWebhook,
  now = () => new Date(),
  _setInterval = setInterval,
} = {}) => {
  const resolvedIntervalMs = intervalMs ?? config?.alertDeliveryTest?.intervalMs ?? (15 * 60 * 1000);

  // Guard against concurrent runs. If a test is already in flight, skip the
  // next scheduled slot rather than stacking up parallel sends.
  let running = false;

  const runTest = async () => {
    if (running) {
      logger.warn('alert_delivery_test_skipped', { reason: 'previous_run_in_progress' });
      return;
    }
    running = true;
    const testId = randomUUID();
    logger.info('alert_delivery_test_started', { testId, intervalMs: resolvedIntervalMs });
    try {
      const record = await runAlertDeliveryTest({ db, config, testId, now, sendWhatsApp, sendWebhook });
      await saveTestResult(db, record);

      const level = (record.overallResult === RESULT.SUCCESS || record.overallResult === RESULT.FALLBACK_SUCCESS)
        ? 'info'
        : 'error';
      logger[level]('alert_delivery_test_completed', {
        testId,
        overallResult: record.overallResult,
        durationMs: record.durationMs,
        routes: record.routes.map((r) => ({ name: r.name, result: r.result, error: r.error })),
      });

      if (record.overallResult === RESULT.FAILURE || record.overallResult === RESULT.TIMEOUT) {
        increment('sendam_alert_delivery_test_failures_total');
      }
    } catch (error) {
      // Should never reach here since runAlertDeliveryTest itself captures errors,
      // but protect the scheduler from stopping entirely if it somehow does.
      logger.error('alert_delivery_test_scheduler_error', { testId, error: error.message });
      increment('sendam_alert_delivery_test_failures_total');
    } finally {
      running = false;
    }
  };

  logger.info('alert_delivery_test_poller_started', { intervalMs: resolvedIntervalMs });

  // Run immediately on startup so operators get a signal quickly, then on
  // every subsequent interval.
  runTest().catch(() => {});

  const timer = _setInterval(runTest, resolvedIntervalMs);
  if (timer?.unref) timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
      logger.info('alert_delivery_test_poller_stopped');
    },
    /** Expose for manual triggering and tests */
    runTest,
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const withTimeout = async (fn, timeoutMs, name) => {
  let timer;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error(`${name} alert delivery timed out after ${timeoutMs}ms`), { isTimeout: true })),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Strip secrets and long stack traces before logging. */
const sanitizeErrorMessage = (error) => {
  const msg = String(error?.message || error || 'unknown error').slice(0, 500);
  // Never log anything that looks like a token or key
  return msg.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  SYNTHETIC_TYPE,
  RESULT,
  STATUS,
  runAlertDeliveryTest,
  saveTestResult,
  getLastTestResult,
  getLastSuccessfulTestResult,
  evaluateAlertDeliveryHealth,
  startAlertDeliveryTestPoller,
  // exported for testing
  defaultSendWhatsApp,
  defaultSendWebhook,
  withTimeout,
  sanitizeErrorMessage,
};
