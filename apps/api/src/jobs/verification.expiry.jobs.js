'use strict';

/**
 * Verification Expiry Job (#333)
 * --------------------------------
 * Background poller that runs the verification expiry sweep on a configurable
 * interval. Integrated into the job registry (src/jobs/index.js) alongside the
 * audit and deposit pollers.
 */

const logger = require('../utils/logger');
const { runVerificationExpirySweep } = require('../compliance/verification.expiry');
const config = require('../config/env');

/** Default: run once every 6 hours. Override via VERIFICATION_EXPIRY_INTERVAL_MS. */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

const startVerificationExpiryPoller = ({ intervalMs } = {}) => {
  const interval = intervalMs
    ?? Number(config.compliance?.expiryIntervalMs ?? DEFAULT_INTERVAL_MS);

  logger.info('verification_expiry_poller_started', { intervalMs: interval });

  const runSweep = async () => {
    try {
      const result = await runVerificationExpirySweep();
      if (result.reminders > 0 || result.escalations > 0) {
        logger.info('verification_expiry_sweep_summary', result);
      }
    } catch (err) {
      logger.error('verification_expiry_poller_error', { error: err.message });
    }
  };

  // Run once immediately, then on interval.
  runSweep();
  const timer = setInterval(runSweep, interval);
  if (timer.unref) timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
      logger.info('verification_expiry_poller_stopped');
    },
  };
};

module.exports = { startVerificationExpiryPoller };
