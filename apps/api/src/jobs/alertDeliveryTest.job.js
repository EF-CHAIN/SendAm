'use strict';

// Issue #228 — Continuously test alert delivery
//
// Background job that runs synthetic alert delivery tests on a configurable
// interval.  Follows the setInterval pattern used by messaging.jobs.js and
// deposits.jobs.js — no new scheduler required.

const logger = require('../utils/logger');
const config = require('../config/env');
const { runAlertDeliveryTest, checkStaleTests } = require('../observability/alertDeliveryTest.service');
const { captureException } = require('../observability/errors');
const { increment } = require('../observability/metrics');

/** Default test interval: 10 minutes. */
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

/** Stale-check runs more frequently than tests to catch missed test windows. */
const STALE_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

/**
 * Start the periodic alert delivery test scheduler.
 *
 * @param {object} [overrides] — Injectable dependencies for unit tests.
 * @returns {{ stop: () => void }}
 */
const startAlertDeliveryTestScheduler = ({
  cfg = config,
  runTest = runAlertDeliveryTest,
  checkStale = checkStaleTests,
  capture = captureException,
  nowFn = Date.now,
} = {}) => {
  const intervalMs = cfg?.alertDeliveryTest?.intervalMs || DEFAULT_INTERVAL_MS;

  logger.info('alert_delivery_test_scheduler_started', {
    intervalMs,
    primaryRoute: cfg?.observability?.errorMonitorWebhookUrl
      ? '[configured]'
      : '[not-configured]',
  });

  // Run immediately on startup so the first health signal is not delayed by a
  // full interval — matching the pattern in messaging.jobs.js.
  const runAndHandle = async () => {
    try {
      await runTest(cfg);
    } catch (error) {
      logger.error('alert_delivery_test_run_failed', { message: error.message });
      increment('sendam_alert_delivery_test_scheduler_error_total');
      capture(error, { source: 'alert_delivery_test_scheduler' }).catch(() => {});
    }
  };

  // Deliberately not awaited — we don't want the startup boot to block on a
  // potentially-failing network call to an external alerting endpoint.
  setImmediate(() => runAndHandle());

  const testTimer = setInterval(runAndHandle, intervalMs);
  testTimer.unref?.();

  // Stale-test detector: runs on its own (shorter) interval so a scheduler
  // that silently dies is detected and surfaced within one minute.
  const staleTimer = setInterval(() => {
    try {
      const { stale, staleSinceMs } = checkStale(cfg, nowFn());
      if (stale) {
        logger.error('alert_delivery_test_stale', {
          staleSinceMs,
          intervalMs,
          message: 'Alert delivery tests have not run successfully within the expected window.',
        });
        increment('sendam_alert_delivery_test_stale_total');
        // Surface as a capturable exception — this fires a real alert to the
        // error monitor so operators are notified of the missed tests.
        capture(
          Object.assign(new Error('Alert delivery tests are stale — scheduler may have stopped'), {
            staleSinceMs,
            intervalMs,
          }),
          { source: 'alert_delivery_stale_detector' },
        ).catch(() => {});
      }
    } catch (error) {
      logger.error('alert_delivery_stale_check_failed', { message: error.message });
    }
  }, STALE_CHECK_INTERVAL_MS);
  staleTimer.unref?.();

  return {
    stop: () => {
      clearInterval(testTimer);
      clearInterval(staleTimer);
      logger.info('alert_delivery_test_scheduler_stopped');
    },
  };
};

module.exports = {
  startAlertDeliveryTestScheduler,
  DEFAULT_INTERVAL_MS,
  STALE_CHECK_INTERVAL_MS,
};
