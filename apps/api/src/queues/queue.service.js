const config = require('../config/env');
const logger = require('../utils/logger');

let Queue;
let Worker;
let IORedis;
let connection;

try {
  ({ Queue, Worker } = require('bullmq'));
  IORedis = require('ioredis');
  connection = config.redis.url ? new IORedis(config.redis.url, { maxRetriesPerRequest: null }) : undefined;
} catch (error) {
  logger.warn('BullMQ is not installed; webhook jobs will run inline in development.');
}

const inlineProcessors = new Map();
const queues = new Map();

const getQueue = (name) => {
  if (!Queue || !connection) return null;
  if (!queues.has(name)) queues.set(name, new Queue(name, { connection }));
  return queues.get(name);
};

const registerProcessor = (name, processor) => {
  inlineProcessors.set(name, processor);
  if (Queue && Worker && connection) {
    return new Worker(name, processor, { connection });
  }
  return null;
};

const enqueue = async (name, jobName, data, options = {}) => {
  const queue = getQueue(name);
  if (queue) {
    return queue.add(jobName, data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
      ...options,
    });
  }

  const processor = inlineProcessors.get(name);
  if (processor) {
    setImmediate(() => processor({ name: jobName, data }).catch((error) => {
      logger.error(`Inline job ${name}:${jobName} failed`, error.message);
    }));
  }
  return { id: `inline-${Date.now()}` };
};

module.exports = {
  enqueue,
  registerProcessor,
};
