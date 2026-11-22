'use strict';

// BullMQ queue metrics exporter (#1016).
//
// Gauges (refreshed on every scrape, per queue):
//   bullmq_waiting_jobs_count   jobs waiting (including prioritized) to be picked up
//   bullmq_active_jobs_count    jobs currently being processed
//   bullmq_redis_memory_used_bytes   Redis used_memory
// Histograms (recorded by the worker around each job, see queues/queue.service.js):
//   bullmq_job_duration_seconds     processor run time
//   bullmq_job_wait_seconds         time from enqueue to start (worker starvation)
//
// The API process and the worker process each expose /metrics. Counts are read
// from Redis so either process reports the same queue depth; the duration
// histograms are only populated in the process that runs the worker.

const logger = require('../utils/logger');
const { setGauge, metricsHandler, isMetricsAuthorized } = require('./metrics');

/** Queues operators care about even when this process has no processor for them. */
const KNOWN_QUEUES = Object.freeze([
  'whatsapp-inbound',
  'whatsapp-outbound-retry',
  'sendam-jobs',
  'partner-webhooks',
  'receipts',
]);

const COLLECT_TIMEOUT_MS = 2000;

const withTimeout = (promise, ms, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const parseUsedMemory = (info) => {
  const match = /^used_memory:(\d+)/m.exec(String(info || ''));
  return match ? Number(match[1]) : null;
};

/**
 * Refresh queue gauges. Each queue is isolated so one failure cannot blank the
 * others. Dependencies are injectable for tests.
 */
const collectBullmqMetrics = async ({
  getQueueHandle = require('../queues/queue.service').getQueueHandle,
  getRegisteredProcessors = require('../queues/queue.service').getRegisteredProcessors,
  getRedisInfo = require('../queues/queue.service').getRedisInfo,
  queueNames,
} = {}) => {
  const names = queueNames || [...new Set([...KNOWN_QUEUES, ...getRegisteredProcessors()])];
  const errors = [];

  for (const name of names) {
    try {
      const queue = getQueueHandle(name);
      if (!queue) continue;
      const counts = await queue.getJobCounts('waiting', 'prioritized', 'active');
      setGauge('bullmq_waiting_jobs_count', (counts.waiting || 0) + (counts.prioritized || 0), { queue: name });
      setGauge('bullmq_active_jobs_count', counts.active || 0, { queue: name });
    } catch (error) {
      errors.push({ queue: name, message: error.message });
      logger.warn('queue_metrics_collect_failed', { queue: name, message: error.message });
    }
  }

  try {
    const used = parseUsedMemory(await getRedisInfo('memory'));
    if (used !== null) setGauge('bullmq_redis_memory_used_bytes', used);
  } catch (error) {
    errors.push({ queue: 'redis', message: error.message });
    logger.warn('queue_metrics_redis_memory_failed', { message: error.message });
  }

  return { queues: names, errors };
};

/**
 * /metrics handler for the API: authorizes first (so unauthenticated callers
 * cannot trigger Redis traffic), refreshes queue gauges with a bounded wait,
 * then renders. A slow or failing Redis degrades to stale gauges, not a 5xx.
 */
const createQueueMetricsHandler = ({ collect = collectBullmqMetrics, timeoutMs = COLLECT_TIMEOUT_MS } = {}) => async (req, res) => {
  if (!isMetricsAuthorized(req.get('authorization'))) return res.sendStatus(403);
  try {
    await withTimeout(collect(), timeoutMs, 'queue metrics collection');
  } catch (error) {
    logger.warn('queue_metrics_refresh_skipped', { message: error.message });
  }
  return metricsHandler(req, res);
};

module.exports = {
  KNOWN_QUEUES,
  collectBullmqMetrics,
  createQueueMetricsHandler,
  parseUsedMemory,
};
