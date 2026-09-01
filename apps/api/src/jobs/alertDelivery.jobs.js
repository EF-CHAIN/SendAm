'use strict';

/**
 * Continuous alert-delivery verification poller (#228)
 * ---------------------------------------------------
 * Runs on a configurable interval in the worker process (like the audit,
 * deposit and verification-expiry pollers). Each tick reconciles outstanding
 * synthetic tests against provider delivery status, detects missed/stalled
 * verification, and dispatches the next synthetic alert if one is due.
 *
 * When continuous verification is not enabled/configured this is a safe no-op
 * that simply reflects the disabled state.
 */
const logger = require('../utils/logger');
const config = require('../config/env');
const prisma = require('../common/prisma');
const { runAlertDeliveryCycle, isEnabled } = require('../observability/alertDelivery.service');

/** Default: every hour. Override via ALERT_DELIVERY_INTERVAL_MS. */
const DEFAULT_INTERVAL_MS = 3600000;

const startAlertDeliveryPoller = ({ intervalMs } = {}) => {
  if (!isEnabled(config)) {
    logger.info('alert_delivery_poller_disabled', { reason: 'not_configured' });
    return { stop: () => {}, started: false };
  }

  const interval = intervalMs ?? Number(config.alertDelivery?.intervalMs ?? DEFAULT_INTERVAL_MS);
  logger.info('alert_delivery_poller_started', { intervalMs: interval });

  let running = false;
  let timer;

  const tick = async () => {
    if (running) return; // never overlap ticks
    running = true;
    try {
      const result = await runAlertDeliveryCycle({ db: prisma, cfg: config });
      if (result.dispatched?.dispatched) {
        logger.info('synthetic_alert_dispatched_summary', {
          testId: result.dispatched.testId,
          syncOutcome: result.dispatched.syncOutcome,
          fallbackUsed: result.dispatched.fallbackUsed,
        });
      }
    } catch (error) {
      logger.error('alert_delivery_poller_error', { error: String(error?.message || error) });
    } finally {
      running = false;
    }
  };

  // Run once immediately, then on interval (matches audit/deposit pollers).
  tick();
  timer = setInterval(tick, interval);
  if (timer.unref) timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
      logger.info('alert_delivery_poller_stopped');
    },
    started: true,
  };
};

module.exports = { startAlertDeliveryPoller };