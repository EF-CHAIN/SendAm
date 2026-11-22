'use strict';

// Job priority classes (#1015).
//
// BullMQ orders jobs inside a single queue by priority (1 is served first,
// larger numbers later, and un-prioritised jobs are served before none of
// them). Priority only has meaning within one queue, so producers that must
// compete fairly (for example a payment submission and a bulk notification)
// have to enqueue onto the same queue with different priority classes.
//
// Priority adds a small per-job cost in Redis (a sorted set instead of a
// list), so classes are deliberately few and fixed.

const PRIORITY = Object.freeze({
  PAYMENT_SUBMISSION: 1,
  WEBHOOK_INTAKE: 2,
  RECEIPTS: 3,
  BULK_MESSAGING: 4,
});

const JOB_CLASSES = Object.freeze({
  paymentSubmission: PRIORITY.PAYMENT_SUBMISSION,
  webhookIntake: PRIORITY.WEBHOOK_INTAKE,
  receipts: PRIORITY.RECEIPTS,
  bulkMessaging: PRIORITY.BULK_MESSAGING,
});

const LOWEST_PRIORITY = PRIORITY.BULK_MESSAGING;

const isValidPriority = (value) => Number.isInteger(value)
  && value >= PRIORITY.PAYMENT_SUBMISSION
  && value <= LOWEST_PRIORITY;

/** Resolve a class name (or an explicit level) to a BullMQ priority number. */
const resolvePriority = (jobClass) => {
  if (typeof jobClass === 'string') {
    if (!Object.prototype.hasOwnProperty.call(JOB_CLASSES, jobClass)) {
      throw new Error(`Unknown job priority class "${jobClass}"`);
    }
    return JOB_CLASSES[jobClass];
  }
  if (!isValidPriority(jobClass)) {
    throw new Error(`Invalid job priority ${jobClass}: expected an integer from 1 to ${LOWEST_PRIORITY}`);
  }
  return jobClass;
};

/** Merge a priority into BullMQ job options without mutating the input. */
const withPriority = (jobClass, options = {}) => ({ ...options, priority: resolvePriority(jobClass) });

/**
 * Enqueue a job with a priority class. `enqueueFn` defaults to the shared
 * queue service and is injectable so callers and tests stay decoupled from Redis.
 */
const enqueuePrioritized = (queueName, jobName, data, jobClass, options = {}, enqueueFn) => {
  const enqueue = enqueueFn || require('./queue.service').enqueue;
  return enqueue(queueName, jobName, data, withPriority(jobClass, options));
};

module.exports = {
  PRIORITY,
  JOB_CLASSES,
  LOWEST_PRIORITY,
  isValidPriority,
  resolvePriority,
  withPriority,
  enqueuePrioritized,
};
