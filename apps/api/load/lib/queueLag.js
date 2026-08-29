'use strict';

/**
 * Queue lag sampling.
 *
 * Latency at the webhook edge only tells half the story: the endpoint
 * acknowledges and enqueues, so a service can look healthy at the HTTP layer
 * while background work falls arbitrarily far behind. Depth answers "how much
 * is waiting" and oldest-job age answers "how long has the oldest thing been
 * waiting" — the second is the one that matters for a user still expecting a
 * reply.
 *
 * When no Redis URL is configured this reports `measured: false` rather than
 * zero. A missing measurement must never read as a healthy one.
 */

const QUEUE_NAMES = ['whatsapp-messages', 'deposits'];

const sampleQueueLag = async ({ redisUrl, queueNames = QUEUE_NAMES } = {}) => {
  if (!redisUrl) {
    return { measured: false, reason: 'no REDIS_URL configured; queue lag not observed' };
  }

  let Queue;
  let IORedis;
  try {
    ({ Queue } = require('bullmq'));
    IORedis = require('ioredis');
  } catch {
    return { measured: false, reason: 'bullmq/ioredis not installed; queue lag not observed' };
  }

  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
  const queues = [];
  try {
    await connection.connect();
    let depth = 0;
    let oldestTimestamp = null;

    for (const name of queueNames) {
      const queue = new Queue(name, { connection });
      queues.push(queue);
      const counts = await queue.getJobCounts('waiting', 'delayed', 'active');
      depth += (counts.waiting || 0) + (counts.delayed || 0) + (counts.active || 0);

      // getJobs is ascending by id, so the first waiting job is the oldest.
      const [oldest] = await queue.getJobs(['waiting'], 0, 0, true);
      if (oldest?.timestamp && (oldestTimestamp === null || oldest.timestamp < oldestTimestamp)) {
        oldestTimestamp = oldest.timestamp;
      }
    }

    return {
      measured: true,
      depth,
      oldestJobAgeMs: oldestTimestamp === null ? 0 : Math.max(0, Date.now() - oldestTimestamp),
      queues: queueNames,
    };
  } catch (error) {
    return { measured: false, reason: `queue sampling failed: ${error.message}` };
  } finally {
    await Promise.all(queues.map((q) => q.close().catch(() => {})));
    await connection.quit().catch(() => {});
  }
};

module.exports = { sampleQueueLag, QUEUE_NAMES };
