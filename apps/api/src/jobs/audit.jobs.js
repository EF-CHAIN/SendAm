'use strict';

const logger = require('../utils/logger');
const { verifyAuditLogIntegrity } = require('../common/audit.service');

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

const startAuditPoller = ({ intervalMs = DEFAULT_INTERVAL_MS } = {}) => {
  logger.info(`Audit log integrity poller started (interval: ${intervalMs}ms)`);

  const runSweep = async () => {
    try {
      await verifyAuditLogIntegrity();
    } catch (err) {
      logger.error(`Audit log integrity check failed to run: ${err.message}`);
    }
  };

  runSweep();

  const timer = setInterval(runSweep, intervalMs);
  if (timer.unref) timer.unref();

  const stop = () => {
    clearInterval(timer);
    logger.info('Audit log integrity poller stopped.');
  };

  return { stop };
};

module.exports = {
  startAuditPoller,
};
