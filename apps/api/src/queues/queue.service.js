const config = require('../config/env');
const logger = require('../utils/logger');
const { getContext, runWithContext, correlationIdFrom } = require('../observability/context');
const { increment, observeDuration } = require('../observability/metrics');
const { captureException } = require('../observability/errors');

let Queue;
let Worker;
let IORedis;
let connection;

try {
  ({ Queue, Worker } = require('bullmq'));
  IORedis = require('ioredis');
  connection = config.redis.url ? new IORedis(config.redis.url, { maxRetriesPerRequest: null }) : undefined;
  connection?.on('error', (error) => logger.error('queue_redis_error', { message: error.message }));
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

const registerProcessor = (name, processor) => {
  const observedProcessor = async (job) => {
    const correlationId = correlationIdFrom(job.data?.correlationId || String(job.id || ''));
    return runWithContext({ correlationId, jobId: job.id, queue: name }, async () => {
      const started = process.hrtime.bigint();
      increment('sendam_queue_jobs_total', { queue: name, status: 'active' });
      try {
        const result = await processor(job);
        increment('sendam_queue_jobs_total', { queue: name, status: 'completed' });
        return result;
      } catch (error) {
        increment('sendam_queue_jobs_total', { queue: name, status: 'failed' });
        logger.error('queue_job_failed', { queue: name, jobId: job.id, error });
        captureException(error, { source: 'worker', queue: name, jobId: job.id });
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
    const worker = new Worker(name, observedProcessor, { connection });
    worker.on('error', (error) => {
      logger.error('queue_worker_error', { queue: name, error });
      captureException(error, { source: 'worker_runtime', queue: name });
    });
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
    setImmediate(() => processor({ name: jobName, data: correlatedData, id: options.jobId }).catch((error) => {
      logger.error('inline_queue_job_failed', { queue: name, jobName, error });
    }));
    return { id: options.jobId || `inline-${Date.now()}` };
  }
  increment('sendam_queue_jobs_total', { queue: name, status: 'enqueued' });
  return { id: `inline-${Date.now()}` };
};

module.exports = {
  enqueue,
  registerProcessor,
  closeQueues,
};
