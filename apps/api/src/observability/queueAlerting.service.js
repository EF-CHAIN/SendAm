const { setGauge, increment } = require('./metrics');
const logger = require('../utils/logger');

const THRESHOLDS = {
  BACKLOG_WARNING: parseInt(process.env.QUEUE_BACKLOG_WARNING_THRESHOLD || '50', 10),
  BACKLOG_CRITICAL: parseInt(process.env.QUEUE_BACKLOG_CRITICAL_THRESHOLD || '200', 10),
  JOB_LAG_WARNING_SECONDS: parseInt(process.env.QUEUE_LAG_WARNING_SECONDS || '300', 10),
  JOB_LAG_CRITICAL_SECONDS: parseInt(process.env.QUEUE_LAG_CRITICAL_SECONDS || '600', 10),
  FAILED_JOBS_THRESHOLD: parseInt(process.env.QUEUE_FAILED_JOBS_THRESHOLD || '10', 10),
};

/**
 * Evaluates queue metrics against service-level alert thresholds and updates Prometheus gauges.
 */
const evaluateQueueHealth = (queueName, stats = {}) => {
  const waiting = stats.waiting || 0;
  const active = stats.active || 0;
  const failed = stats.failed || 0;
  const delayed = stats.delayed || 0;
  const oldestJobAgeSeconds = stats.oldestJobAgeSeconds || 0;
  const backlog = waiting + active;

  // Update Prometheus gauges
  setGauge('sendam_queue_backlog_size', backlog, { queue: queueName });
  setGauge('sendam_queue_waiting_jobs', waiting, { queue: queueName });
  setGauge('sendam_queue_active_jobs', active, { queue: queueName });
  setGauge('sendam_queue_failed_jobs', failed, { queue: queueName });
  setGauge('sendam_queue_delayed_jobs', delayed, { queue: queueName });
  setGauge('sendam_queue_lag_seconds', oldestJobAgeSeconds, { queue: queueName });

  const alerts = [];

  // Check backlog thresholds
  if (backlog >= THRESHOLDS.BACKLOG_CRITICAL) {
    const msg = `CRITICAL: Queue "${queueName}" backlog (${backlog}) exceeds critical threshold (${THRESHOLDS.BACKLOG_CRITICAL})`;
    alerts.push(msg);
    logger.error('queue_backlog_critical', { queue: queueName, backlog, threshold: THRESHOLDS.BACKLOG_CRITICAL });
    increment('sendam_queue_alerts_total', { queue: queueName, severity: 'critical', type: 'backlog' });
  } else if (backlog >= THRESHOLDS.BACKLOG_WARNING) {
    const msg = `WARNING: Queue "${queueName}" backlog (${backlog}) exceeds warning threshold (${THRESHOLDS.BACKLOG_WARNING})`;
    alerts.push(msg);
    logger.warn('queue_backlog_warning', { queue: queueName, backlog, threshold: THRESHOLDS.BACKLOG_WARNING });
    increment('sendam_queue_alerts_total', { queue: queueName, severity: 'warning', type: 'backlog' });
  }

  // Check latency/lag thresholds
  if (oldestJobAgeSeconds >= THRESHOLDS.JOB_LAG_CRITICAL_SECONDS) {
    const msg = `CRITICAL: Queue "${queueName}" oldest job age (${oldestJobAgeSeconds}s) exceeds critical lag threshold (${THRESHOLDS.JOB_LAG_CRITICAL_SECONDS}s)`;
    alerts.push(msg);
    logger.error('queue_lag_critical', { queue: queueName, lagSeconds: oldestJobAgeSeconds, threshold: THRESHOLDS.JOB_LAG_CRITICAL_SECONDS });
    increment('sendam_queue_alerts_total', { queue: queueName, severity: 'critical', type: 'lag' });
  } else if (oldestJobAgeSeconds >= THRESHOLDS.JOB_LAG_WARNING_SECONDS) {
    const msg = `WARNING: Queue "${queueName}" oldest job age (${oldestJobAgeSeconds}s) exceeds warning lag threshold (${THRESHOLDS.JOB_LAG_WARNING_SECONDS}s)`;
    alerts.push(msg);
    logger.warn('queue_lag_warning', { queue: queueName, lagSeconds: oldestJobAgeSeconds, threshold: THRESHOLDS.JOB_LAG_WARNING_SECONDS });
    increment('sendam_queue_alerts_total', { queue: queueName, severity: 'warning', type: 'lag' });
  }

  // Check failed jobs
  if (failed >= THRESHOLDS.FAILED_JOBS_THRESHOLD) {
    const msg = `CRITICAL: Queue "${queueName}" failed jobs count (${failed}) exceeds threshold (${THRESHOLDS.FAILED_JOBS_THRESHOLD})`;
    alerts.push(msg);
    logger.error('queue_failed_jobs_critical', { queue: queueName, failed, threshold: THRESHOLDS.FAILED_JOBS_THRESHOLD });
    increment('sendam_queue_alerts_total', { queue: queueName, severity: 'critical', type: 'failures' });
  }

  return {
    queue: queueName,
    isHealthy: alerts.length === 0,
    backlog,
    alerts,
    stats: {
      waiting,
      active,
      failed,
      delayed,
      backlog,
      oldestJobAgeSeconds,
    },
  };
};

module.exports = {
  THRESHOLDS,
  evaluateQueueHealth,
};
