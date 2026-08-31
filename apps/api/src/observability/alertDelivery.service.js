'use strict';

/**
 * Continuous alert-delivery verification (#228)
 * -------------------------------------------------
 * Proves the actual outbound alert-routing pipeline works end-to-end instead
 * of merely checking that monitoring components are up.
 *
 * On a configured interval a synthetic test message is dispatched to an
 * INTERNAL test recipient (ALERT_TEST_RECIPIENT) through the real WhatsApp
 * Cloud API outbound pipeline, marked clearly as synthetic so it can never be
 * mistaken for a customer alert or page a customer. Delivery is confirmed from
 * the provider's status webhook (via the linked Notification row reaching
 * `delivered`/`read`). If the primary text route fails synchronously, a
 * configured template route is tried once as a bounded fallback. A persisted
 * singleton state exposes the last successful end-to-end verification, and a
 * stalled scheduler (no test, no success for several intervals) surfaces as an
 * actionable `failed`/"missed_test" state.
 *
 * Idempotency / anti-storm: `testId` is deterministic per interval epoch and
 * unique, so duplicate scheduler executions collide on the constraint and only
 * one test per interval can ever be created; dispatch is additionally gated on
 * an in-flight test and the persisted last-dispatch timestamp.
 */
const logger = require('../utils/logger');
const config = require('../config/env');
const { increment, setGauge } = require('../observability/metrics');

// Lazy requires keep this module dependency-injectable (and unit-testable
// without a generated Prisma client or a live WhatsApp module): the real
// `common/prisma` and `services/whatsapp.service` are only loaded when a caller
// does not pass its own injected `db` / `whatsappImpl`.
const prismaDefault = () => require('../common/prisma');
const whatsappDefault = () => require('../services/whatsapp.service');

const TEST_REFERENCE_TYPE = 'alert-test';
const TEST_CHANNEL = 'whatsapp';
const TEST_TYPE = 'synthetic_test';
const STATE_ID = 'main';
const TEST_PREFIX = 'synthetic-alert';

const ROUTES = { TEXT: 'whatsapp-text', TEMPLATE: 'whatsapp-template' };

const TEST_STATUS = {
  DISPATCHED: 'dispatched',
  ACCEPTED: 'accepted',
  CONFIRMED: 'confirmed',
  FAILED: 'failed',
  TIMED_OUT: 'timed_out',
};

const HEALTH = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
  DISABLED: 'disabled',
};

// Notification statuses that constitute end-to-end delivery confirmation.
const CONFIRMING_STATUSES = new Set(['delivered', 'read']);

/**
 * Whether continuous verification is active. Requires the recipient to be set,
 * the kill switch not to be disabled, and a real transport that can report
 * provider delivery status (the `sim` transport has no delivery webhook, so
 * confirmation would be impossible and it is deliberately left disabled).
 */
const isEnabled = (cfg = config) => Boolean(
  cfg.alertDelivery?.enabled
  && cfg.alertDelivery?.recipient
  && (cfg.messageTransport == null || cfg.messageTransport === 'meta'),
);

/** Deterministic, unique-per-interval test id → hard anti-storm guarantee. */
const testIdForEpoch = (now, cfg) => (
  `${TEST_PREFIX}:${Math.floor(now.getTime() / cfg.alertDelivery.intervalMs)}`
);

const syntheticBody = (testId) => (
  `[SendAm alert-delivery test] correlationId=${TEST_PREFIX}:${testId}`
);

const syntheticNotification = (testId) => ({
  type: TEST_TYPE,
  channel: TEST_CHANNEL,
  referenceType: TEST_REFERENCE_TYPE,
  referenceId: testId,
});

/** Ordered routes to exercise. Primary = free-form text; fallback = template (if configured). */
const buildRoutes = (cfg = config) => {
  const routes = [{ name: ROUTES.TEXT, kind: 'text' }];
  if (cfg.alertDelivery?.templateName) {
    routes.push({
      name: ROUTES.TEMPLATE,
      kind: 'template',
      templateName: cfg.alertDelivery.templateName,
      templateLanguage: cfg.alertDelivery.templateLanguage || 'en',
    });
  }
  return routes;
};

const readState = async (db) => db.alertDeliveryState.findUnique({ where: { id: STATE_ID } });

const getOrCreateState = async (db) => {
  const existing = await readState(db);
  if (existing) return existing;
  return db.alertDeliveryState.create({
    data: { id: STATE_ID, enabled: false, overallStatus: HEALTH.UNKNOWN },
  });
};

const persistState = async (db, update, fallbackCreate = {}) => db.alertDeliveryState.upsert({
  where: { id: STATE_ID },
  update,
  create: { id: STATE_ID, ...buildStateDefaults(), ...fallbackCreate },
});

const buildStateDefaults = () => ({ enabled: false, overallStatus: HEALTH.UNKNOWN });

/** Update Prometheus gauges from the persisted state. Never includes recipients/secrets. */
const updateGauges = (state) => {
  const score = { healthy: 1, degraded: 0.5, failed: 0, unknown: 0.5, disabled: 0 }[state?.overallStatus];
  setGauge('sendam_alert_delivery_status', Number.isFinite(score) ? score : 0, {});
  const last = state?.lastSuccessfulTestAt ? new Date(state.lastSuccessfulTestAt).getTime() : null;
  if (last) setGauge('sendam_alert_delivery_last_success_timestamp_seconds', Math.floor(last / 1000), {});
  const age = last ? Math.max(0, (Date.now() - last) / 1000) : -1;
  setGauge('sendam_alert_delivery_age_seconds', age, {});
  increment('sendam_alert_delivery_checks_total', {});
};

/**
 * Dispatch one synthetic alert test through every configured route.
 * Returns the synchronous dispatch summary. Delivery confirmation happens
 * asynchronously via the status webhook and is reconciled later.
 */
const dispatchSyntheticTest = async ({
  db = prismaDefault(),
  cfg = config,
  now = new Date(),
  whatsappImpl = whatsappDefault(),
} = {}) => {
  const recipient = cfg.alertDelivery.recipient;

  // In-flight guard: only one test outstanding at a time prevents storms while
  // the provider recovers.
  const inflight = await db.alertDeliveryTest.findFirst({
    where: { status: { in: [TEST_STATUS.DISPATCHED, TEST_STATUS.ACCEPTED] } },
  });
  if (inflight) {
    logger.info('synthetic_alert_started', { testId: inflight.testId, outcome: 'skipped_in_flight' });
    return { dispatched: false, reason: 'in_flight', testId: inflight.testId };
  }

  const state = await getOrCreateState(db);
  if (state.lastDispatchAt && now.getTime() - new Date(state.lastDispatchAt).getTime() < cfg.alertDelivery.intervalMs) {
    logger.info('synthetic_alert_started', { outcome: 'skipped_not_due' });
    return { dispatched: false, reason: 'not_due' };
  }

  const testId = testIdForEpoch(now, cfg);
  logger.info('synthetic_alert_started', { testId, outcome: 'starting' });

  let record;
  try {
    record = await db.alertDeliveryTest.create({
      data: {
        testId,
        recipient,
        status: TEST_STATUS.DISPATCHED,
        routes: [],
        primaryRoute: ROUTES.TEXT,
        attemptedAt: now,
      },
    });
  } catch (err) {
    // Unique epoch collision → another replica already dispatched this interval.
    if (err?.code === 'P2002') {
      logger.info('synthetic_alert_started', { testId, outcome: 'skipped_duplicate' });
      return { dispatched: false, reason: 'duplicate', testId };
    }
    throw err;
  }

  const notification = syntheticNotification(testId);
  const routes = buildRoutes(cfg);
  const perRoute = [];
  let providerMessageId = null;
  let lastError = null;

  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index];
    const isPrimary = index === 0;
    let result;
    try {
      if (route.kind === 'text') {
        result = await whatsappImpl.sendTextMessage(recipient, syntheticBody(testId), {
          correlationId: `${TEST_PREFIX}:${testId}:${route.name}`,
          notification,
          prisma: db,
          enforceWindow: false,
        });
      } else {
        result = await whatsappImpl.sendTemplateMessage(
          recipient,
          route.templateName,
          route.templateLanguage,
          [],
          {
            notification,
            prisma: db,
            correlationId: `${TEST_PREFIX}:${testId}:${route.name}`,
          },
        );
        const wid = result?.messages?.[0]?.id;
        result = wid
          ? { outcome: 'accepted', providerMessageId: wid }
          : { outcome: 'failed', error: { kind: 'template', message: 'template send did not return a message id' } };
      }
    } catch (error) {
      result = { outcome: 'failed', error: { kind: 'route_error', message: String(error?.message || error || 'send failed') } };
    }

    if (result.outcome === 'accepted' && result.providerMessageId) {
      providerMessageId = result.providerMessageId;
      perRoute.push({
        name: route.name,
        outcome: 'accepted',
        providerMessageId,
        attemptedAt: now.toISOString(),
      });
      logger.info('synthetic_alert_dispatched', { testId, route: route.name, providerMessageId });
      break;
    }

    const reason = result.error?.message || result.error?.kind || 'send_failed';
    lastError = reason;
    perRoute.push({ name: route.name, outcome: 'failed', attemptedAt: now.toISOString(), error: reason });
    if (isPrimary) {
      logger.info('synthetic_alert_route_failed', { testId, route: route.name, reason });
      if (index < routes.length - 1) {
        logger.info('synthetic_alert_fallback_started', { testId, fallbackRoute: routes[index + 1].name, primaryReason: reason });
      }
    }
  }

  const syncOutcome = providerMessageId ? 'accepted' : 'failed';
  const fallbackUsed = perRoute.length > 1;
  const successful = syncOutcome === 'accepted';
  const overallStatus = !successful ? HEALTH.FAILED : (fallbackUsed ? HEALTH.DEGRADED : HEALTH.HEALTHY);

  await db.alertDeliveryTest.update({
    where: { id: record.id },
    data: {
      status: successful ? TEST_STATUS.ACCEPTED : TEST_STATUS.FAILED,
      routes: perRoute,
      fallbackUsed,
      syncOutcome,
      providerMessageId,
      acceptedAt: successful ? now : null,
      failedAt: successful ? null : now,
      failureReason: successful ? null : 'all_routes_failed_synchronously',
    },
  });

  const stateUpdate = {
    enabled: true,
    lastDispatchAt: now,
    lastTestId: testId,
    overallStatus,
    routesDiagnostics: { updatedAt: now.toISOString(), overallStatus, fallbackUsed, routes: routes.map((r) => r.name) },
  };
  if (!successful) {
    stateUpdate.lastFailureAt = now;
    stateUpdate.lastFailureReason = 'all_routes_failed_synchronously';
    stateUpdate.lastFailureDetail = { routes: perRoute, lastError };
  }
  await persistState(db, stateUpdate, stateUpdate);

  if (fallbackUsed && successful) {
    logger.info('synthetic_alert_fallback_succeeded', { testId, fallbackRoute: perRoute[1].name });
    logger.info('synthetic_alert_verification_degraded', { testId });
  } else if (!successful) {
    logger.error('synthetic_alert_verification_failed', { testId, routes: perRoute });
  }

  return {
    dispatched: true,
    testId,
    syncOutcome,
    providerMessageId,
    fallbackUsed,
    overallStatus,
  };
};

/** Confirm a resolved test: update the test row and never overwrite lastSuccessfulTestAt on failure. */
const confirmTest = async (db, test, note, now) => {
  const fallbackUsed = Boolean(test.fallbackUsed);
  const health = fallbackUsed ? HEALTH.DEGRADED : HEALTH.HEALTHY;
  await db.alertDeliveryTest.update({
    where: { id: test.id },
    data: { status: TEST_STATUS.CONFIRMED, confirmedAt: note.deliveredAt || note.readAt || now },
  });
  await persistState(db, {
    enabled: true,
    overallStatus: health,
    lastSuccessfulTestAt: now,
    lastTestId: test.testId,
    routesDiagnostics: { updatedAt: now.toISOString(), overallStatus: health, fallbackUsed },
  }, { enabled: true, overallStatus: health, lastSuccessfulTestAt: now, lastTestId: test.testId });
  logger.info(fallbackUsed ? 'synthetic_alert_fallback_succeeded' : 'synthetic_alert_delivery_confirmed', {
    testId: test.testId, fallbackUsed, providerStatus: note.status,
  });
  logger.info('synthetic_alert_acknowledged', { testId: test.testId, status: note.status });
  return { outcome: 'confirmed', providerStatus: note.status, degraded: fallbackUsed };
};

const markFailed = async (db, test, reason, detail, now, status = TEST_STATUS.FAILED) => {
  await db.alertDeliveryTest.update({
    where: { id: test.id },
    data: {
      status,
      failedAt: now,
      timeoutAt: status === TEST_STATUS.TIMED_OUT ? now : null,
      failureReason: reason,
    },
  });
  await persistState(db, {
    enabled: true,
    overallStatus: HEALTH.FAILED,
    lastFailureAt: now,
    lastFailureReason: reason,
    lastFailureDetail: detail,
  }, { enabled: true, overallStatus: HEALTH.FAILED, lastFailureAt: now, lastFailureReason: reason, lastFailureDetail: detail });
  if (status === TEST_STATUS.TIMED_OUT) {
    logger.error('synthetic_alert_verification_timed_out', { testId: test.testId, reason });
  } else {
    logger.error('synthetic_alert_verification_failed', { testId: test.testId, reason, detail });
  }
  return { outcome: status, reason };
};

/**
 * Reconcile outstanding (dispatched/accepted) tests against their Notification's
 * provider delivery status: confirm on delivered/read, fail on provider failure,
 * or time out when no acknowledgement arrives within ALERT_DELIVERY_ACK_TIMEOUT_MS.
 */
const reconcileInFlightTests = async ({ db = prismaDefault(), cfg = config, now = new Date() } = {}) => {
  const ackTimeoutMs = cfg.alertDelivery.ackTimeoutMs;
  const inflight = await db.alertDeliveryTest.findMany({
    where: { status: { in: [TEST_STATUS.DISPATCHED, TEST_STATUS.ACCEPTED] } },
  });
  const results = [];
  for (const test of inflight) {
    const note = await db.notification.findFirst({
      where: { referenceType: TEST_REFERENCE_TYPE, referenceId: test.testId },
      orderBy: { createdAt: 'desc' },
    });
    let change = null;
    if (CONFIRMING_STATUSES.has(note?.status)) {
      change = await confirmTest(db, test, note, now);
    } else if (note?.status === 'failed') {
      const detail = { providerMessageId: note.providerMessageId, providerError: note.failureMessage || note.error || null };
      change = await markFailed(db, test, 'provider_failed', detail, now);
    } else if (now.getTime() - new Date(test.attemptedAt).getTime() > ackTimeoutMs) {
      change = await markFailed(db, test, `acknowledgement_timeout:${ackTimeoutMs}ms`, { ackTimeoutMs }, now, TEST_STATUS.TIMED_OUT);
    }
    if (change) results.push({ testId: test.testId, ...change });
    increment('sendam_alert_delivery_outcomes_total', { outcome: change?.outcome || 'pending' });
  }
  return results;
};

/**
 * Missed-test detection: if no successful end-to-end verification has happened
 * for `intervalMs * missedFactor` and no test is in flight (e.g. the scheduler
 * stopped), the verification is unhealthy. A failure never clears the last
 * successful timestamp.
 */
const detectMissedVerification = async ({ db = prismaDefault(), cfg = config, now = new Date() } = {}) => {
  const state = await getOrCreateState(db);
  if (!state.lastSuccessfulTestAt) return null; // nothing succeeded yet → not "missed", just not-yet-verified
  const expectedMs = cfg.alertDelivery.intervalMs * cfg.alertDelivery.missedFactor;
  const sinceSuccessMs = now.getTime() - new Date(state.lastSuccessfulTestAt).getTime();
  if (sinceSuccessMs <= expectedMs) return null;

  const inflight = await db.alertDeliveryTest.count({
    where: { status: { in: [TEST_STATUS.DISPATCHED, TEST_STATUS.ACCEPTED] } },
  });
  if (inflight > 0) return null; // a test is in progress; reconciliation owns it

  await persistState(db, {
    enabled: true,
    overallStatus: HEALTH.FAILED,
    lastFailureAt: now,
    lastFailureReason: 'missed_test',
    lastFailureDetail: {
      lastSuccessfulTestAt: state.lastSuccessfulTestAt.toISOString(),
      expectedMs,
      sinceSuccessMs,
    },
  }, { enabled: true, overallStatus: HEALTH.FAILED, lastFailureAt: now, lastFailureReason: 'missed_test' });
  logger.error('synthetic_alert_verification_missed', {
    testId: state.lastTestId,
    lastSuccessfulTestAt: state.lastSuccessfulTestAt,
    expectedMs,
    sinceSuccessMs,
  });
  return { missed: true, lastSuccessfulTestAt: state.lastSuccessfulTestAt, sinceSuccessMs };
};

/** Disable/reflect the disabled state (no-op kept for observability). */
const ensureDisabledState = async (db, now) => {
  logger.info('synthetic_alert_disabled', { reason: 'not_configured', transport: config.messageTransport });
  await persistState(db, { enabled: false, overallStatus: HEALTH.DISABLED, routesDiagnostics: { updatedAt: now.toISOString() } },
    { enabled: false, overallStatus: HEALTH.DISABLED });
  return HEALTH.DISABLED;
};

/**
 * Run one full verification cycle (reconcile → missed-detection → maybe dispatch).
 * Safe to call on every interval even when disabled.
 */
const runAlertDeliveryCycle = async ({
  db = prismaDefault(),
  cfg = config,
  now = new Date(),
  whatsappImpl = whatsappDefault(),
} = {}) => {
  if (!isEnabled(cfg)) {
    await ensureDisabledState(db, now);
    updateGauges(await readState(db));
    return { enabled: false, status: HEALTH.DISABLED };
  }
  const reconciled = await reconcileInFlightTests({ db, cfg, now });
  const missed = await detectMissedVerification({ db, cfg, now });
  const dispatched = await dispatchSyntheticTest({ db, cfg, now, whatsappImpl });
  const state = await readState(db);
  updateGauges(state);
  return { enabled: true, status: state?.overallStatus || HEALTH.UNKNOWN, reconciled, missed, dispatched };
};

/**
 * Read the current status/history for the admin API. Read-only: never creates
 * rows and never exposes recipients or secrets.
 */
const getStatus = async ({ db = prismaDefault(), cfg = config } = {}) => {
  const state = await readState(db);
  const recentTests = await db.alertDeliveryTest.findMany({ orderBy: { attemptedAt: 'desc' }, take: 10 });
  // Never expose the internal test recipient (or any secret-bearing field).
  const sanitize = (t) => ({ ...t, recipient: undefined });
  return {
    enabled: isEnabled(cfg),
    overallStatus: state?.overallStatus || HEALTH.UNKNOWN,
    lastSuccessfulTestAt: state?.lastSuccessfulTestAt || null,
    lastTestId: state?.lastTestId || null,
    lastDispatchAt: state?.lastDispatchAt || null,
    lastFailureAt: state?.lastFailureAt || null,
    lastFailureReason: state?.lastFailureReason || null,
    recentTests: recentTests.map(sanitize),
  };
};

module.exports = {
  isEnabled,
  buildRoutes,
  dispatchSyntheticTest,
  reconcileInFlightTests,
  detectMissedVerification,
  runAlertDeliveryCycle,
  getStatus,
  updateGauges,
  testIdForEpoch,
  // Constants exposed for tests.
  TEST_STATUS,
  HEALTH,
  TEST_REFERENCE_TYPE,
  TEST_PREFIX,
  STATE_ID,
  ROUTES,
};