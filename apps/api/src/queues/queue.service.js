const config = require('../config/env');
const logger = require('../utils/logger');
const { getContext, runWithContext, correlationIdFrom } = require('../observability/context');
const { increment, observeDuration } = require('../observability/metrics');
const { captureException } = require('../observability/errors');
const {
  getRedisConnection,
  getRedisStatus,
  redisIsAvailable,
  resetRedisConnection,
} = require('../config/redis');

let Queue;
let Worker;
let connection;

try {
  ({ Queue, Worker } = require('bullmq'));
  // The connection is shared process-wide with a single configured policy
  // (TLS, reconnect backoff, command timeouts, Sentinel topology) and drives
  // disconnect/failover/recovery metrics. See src/config/redis.js.
  connection = getRedisConnection(config);
} catch (_error) {
  logger.warn('BullMQ is not installed; webhook jobs will run inline in development.');
}

const inlineProcessors = new Map();
const queues = new Map();
const workers = new Map();

const getQueue = (name) => {
  if (!Queue || !connection) return null;
  if (!queues.has(name)) queues.set(name, new Queue(name, { connection }));
  return queues.get(name);
};

const { moveToDeadLetterQueue } = require('./dlq.service');

const registerProcessor = (name, processor) => {
  const observedProcessor = async (job, token) => {
    const correlationId = correlationIdFrom(job.data?.correlationId || String(job.id || ''));
    return runWithContext({ correlationId, jobId: job.id, queue: name }, async () => {
      const started = process.hrtime.bigint();
      increment('sendam_queue_jobs_total', { queue: name, status: 'active' });
      const enqueuedAt = Number(job.timestamp);
      if (Number.isFinite(enqueuedAt)) {
        observeDuration('sendam_queue_job_age_seconds', { queue: name }, Math.max(0, (Date.now() - enqueuedAt) / 1000));
      }
      try {
        const result = await processor(job, token);
        increment('sendam_queue_jobs_total', { queue: name, status: 'completed' });
        return result;
      } catch (error) {
        increment('sendam_queue_jobs_total', { queue: name, status: 'failed' });
        logger.error('queue_job_failed', { queue: name, jobId: job.id, error });
        captureException(error, { source: 'worker', queue: name, jobId: job.id });

        const maxAttempts = job?.opts?.attempts || 3;
        if (job && (job.attemptsMade || 1) >= maxAttempts) {
          moveToDeadLetterQueue(job, error, { queueName: name }).catch((dlqErr) => {
            logger.error('dlq_move_failed', { queue: name, jobId: job.id, error: dlqErr.message });
          });
        }
        throw error;
      } finally {
        observeDuration(
          'sendam_queue_job_duration_seconds',
          { queue: name },
          Number(process.hrtime.bigint() - started) / 1e9,
        );
      }
    });
  };
  inlineProcessors.set(name, observedProcessor);
  if (Queue && Worker && connection) {
    if (workers.has(name)) return workers.get(name);
    const worker = new Worker(name, observedProcessor, {
      connection,
      concurrency: config.worker.concurrency,
      lockDuration: config.worker.lockDurationMs,
    });
    worker.on('completed', (job) => logger.info('queue_job_completed', {
      queue: name,
      jobId: job.id,
      jobName: job.name,
    }));
    worker.on('failed', (job, error) => {
      logger.error('queue_job_failed', {
        queue: name,
        jobId: job?.id,
        jobName: job?.name,
        attemptsMade: job?.attemptsMade,
        message: error.message,
      });
      const maxAttempts = job?.opts?.attempts || 3;
      if (job && (job.attemptsMade || 1) >= maxAttempts) {
        moveToDeadLetterQueue(job, error, { queueName: name }).catch((dlqErr) => {
          logger.error('dlq_move_failed', { queue: name, jobId: job?.id, error: dlqErr.message });
        });
      }
    });
    worker.on('error', (error) => {
      logger.error('queue_worker_error', { queue: name, error });
      captureException(error, { source: 'worker_runtime', queue: name });
    });
    workers.set(name, worker);
    return worker;
  }
  return null;
};

const enqueue = async (name, jobName, data, options = {}) => {
  const queue = getQueue(name);
  const correlationId = getContext().correlationId || correlationIdFrom(options.jobId);
  const correlatedData = { ...data, correlationId };
  if (queue) {
    const job = await queue.add(jobName, correlatedData, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
      ...options,
    });
    increment('sendam_queue_jobs_total', { queue: name, status: 'enqueued' });
    return job;
  }

  const processor = inlineProcessors.get(name);
  if (processor) {
    // Safeguard: reaching here means Redis is not configured (or is down) and
    // the job is being executed in-process rather than durably queued. That is
    // fine for local development, but an operator must not mistake it for a
    // durable enqueue — so we raise an explicit metric + alert instead of
    // silently degrading. Production is protected by validateEnv (rediss://
    // required) and enqueue() throwing when nothing can process the job.
    increment('sendam_queue_inline_fallback_total', { queue: name });
    logger.warn('queue_inline_fallback', {
      queue: name,
      reason: connection ? 'redis-not-ready' : 'redis-unconfigured',
      status: getRedisStatus().status,
    });
    setImmediate(() => processor({ name: jobName, data: correlatedData, id: options.jobId }).catch((error) => {
      logger.error('inline_queue_job_failed', { queue: name, jobName, error });
    }));
    return { id: options.jobId || `inline-${Date.now()}` };
  }
  increment('sendam_queue_jobs_total', { queue: name, status: 'failed' });
  throw new Error(`Queue "${name}" is unavailable: configure REDIS_URL and run the worker process`);
};

const closeQueues = async () => {
  await Promise.all([...workers.values()].map((worker) => worker.pause()));
  await Promise.all([...workers.values()].map((worker) => worker.close()));
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  workers.clear();
  queues.clear();
  inlineProcessors.clear();
  await resetRedisConnection();
};

const pingRedis = async (timeoutMs = 1000) => {
  if (!connection) throw new Error('Redis connection is unavailable');
  if (!redisIsAvailable()) {
    throw new Error(`Redis is not ready (status=${getRedisStatus().status})`);
  }
  await Promise.race([
    connection.ping(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Redis health check timed out')), timeoutMs)),
  ]);
};

module.exports = {
  enqueue,
  registerProcessor,
  closeQueues,
  pingRedis,
};
