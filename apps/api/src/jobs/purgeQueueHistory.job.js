'use strict';

// Daily purge of completed and failed BullMQ job history.
//
// Job metadata is only bounded by the count-based `removeOnComplete` /
// `removeOnFail` options set at enqueue time. Jobs enqueued without those
// options, or by older releases, accumulate in Redis indefinitely and consume
// RAM. This job applies an age-based limit using `queue.clean()` so Redis
// memory stays bounded under continuous operation.

const logger = require('../utils/logger');
const { increment } = require('../observability/metrics');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = DAY_MS;
const DEFAULT_RETENTION_DAYS = 7;
// Bounded batches keep each Redis call short; clean() with no limit can block
// the single-threaded Redis server while it deletes millions of keys.
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_MAX_BATCHES = 1000;
const DEFAULT_INITIAL_DELAY_MS = 60 * 1000;
const PURGE_STATUSES = ['completed', 'failed'];

const positiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const retentionMsFromEnv = (env = process.env) => (
  positiveNumber(env.QUEUE_HISTORY_RETENTION_DAYS, DEFAULT_RETENTION_DAYS) * DAY_MS
);

/**
 * Remove one status of history older than `retentionMs` from a queue, in
 * batches, until the queue reports fewer removals than the batch size.
 */
const cleanStatus = async (queue, status, { retentionMs, batchSize, maxBatches }) => {
  let removed = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const ids = await queue.clean(retentionMs, batchSize, status);
    const count = Array.isArray(ids) ? ids.length : Number(ids) || 0;
    removed += count;
    if (count < batchSize) break;
  }
  return removed;
};

/**
 * Purge completed and failed job metadata older than the retention window from
 * every queue. One queue or status failing does not stop the others; the
 * failure is counted and returned in the report.
 */
const purgeQueueHistory = async ({
  queues,
  retentionMs = retentionMsFromEnv(),
  batchSize = DEFAULT_BATCH_SIZE,
  maxBatches = DEFAULT_MAX_BATCHES,
} = {}) => {
  const startedAt = new Date();
  const results = [];
  for (const [name, queue] of Object.entries(queues || {})) {
    if (!queue || typeof queue.clean !== 'function') continue;
    for (const status of PURGE_STATUSES) {
      try {
        const removed = await cleanStatus(queue, status, { retentionMs, batchSize, maxBatches });
        if (removed > 0) increment('sendam_queue_history_purged_total', { queue: name, status }, removed);
        results.push({ queue: name, status, removed });
      } catch (error) {
        increment('sendam_queue_history_purge_failures_total', { queue: name, status });
        logger.error('queue_history_purge_failed', { queue: name, status, message: error.message });
        results.push({ queue: name, status, removed: 0, error: error.message });
      }
    }
  }

  const report = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    retentionMs,
    totalRemoved: results.reduce((sum, entry) => sum + entry.removed, 0),
    failures: results.filter((entry) => entry.error).length,
    results,
  };
  logger.info('queue_history_purge_complete', report);
  return report;
};

/** Resolve the live queues for every registered processor. */
const defaultQueueResolver = () => {
  const { getRegisteredProcessors, getQueue } = require('../queues/queue.service');
  const queues = {};
  for (const name of getRegisteredProcessors()) {
    const queue = getQueue(name);
    if (queue) queues[name] = queue;
  }
  return queues;
};

const startQueueHistoryPurge = ({
  intervalMs = DEFAULT_INTERVAL_MS,
  initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
  resolveQueues = defaultQueueResolver,
  ...options
} = {}) => {
  logger.info('queue_history_purge_started', { intervalMs });

  const run = async () => {
    try {
      return await purgeQueueHistory({ queues: resolveQueues(), ...options });
    } catch (error) {
      logger.error('queue_history_purge_run_failed', { message: error.message });
      return null;
    }
  };

  const interval = setInterval(run, intervalMs);
  if (interval.unref) interval.unref();
  // A short delayed first run clears any backlog without waiting a full day,
  // while staying out of the boot path.
  const initial = setTimeout(run, initialDelayMs);
  if (initial.unref) initial.unref();

  return {
    run,
    stop: () => {
      clearInterval(interval);
      clearTimeout(initial);
      logger.info('queue_history_purge_stopped');
    },
  };
};

module.exports = {
  DEFAULT_INTERVAL_MS,
  DEFAULT_RETENTION_DAYS,
  PURGE_STATUSES,
  purgeQueueHistory,
  retentionMsFromEnv,
  startQueueHistoryPurge,
};
