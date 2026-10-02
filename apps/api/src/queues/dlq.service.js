'use strict';

/**
 * @fileoverview Dead-Letter Queue (DLQ) Service
 * Manages exhausted and unrecoverable failed background jobs (e.g. WhatsApp inbound messages),
 * storing them in Redis and/or in-memory store with PII redaction, supporting listing,
 * inspection, idempotent replaying, and discarding.
 *
 * @example
 * const { moveToDeadLetterQueue, listDeadLetterJobs, replayDeadLetterJob } = require('./dlq.service');
 *
 * // 1. Move exhausted job to DLQ
 * const dlqRecord = await moveToDeadLetterQueue(failedJob, new Error('Webhook timeout'), {
 *   queueName: 'whatsapp-inbound',
 * });
 *
 * // 2. List pending DLQ jobs
 * const pending = await listDeadLetterJobs({ status: 'pending', limit: 20 });
 *
 * // 3. Replay a DLQ job with idempotency check
 * const result = await replayDeadLetterJob(dlqRecord.id, {
 *   queueService,
 *   actorId: 'admin_user_123',
 *   actorType: 'operator',
 * });
 */

const crypto = require('crypto');
const logger = require('../utils/logger');
const { redact } = require('../../test/contract/helpers');
const config = require('../config/env');

const getPrisma = () => {
  try {
    return require('../common/prisma');
  } catch (_e) {
    return null;
  }
};

let redisClient;

if (config.redis && config.redis.url) {
  try {
    // Share the process-wide connection configured in src/config/redis.js so
    // the DLQ inherits the same TLS / backoff / timeout / topology policy and
    // feeds the same disconnect/failover/recovery metrics. Commands issued
    // while Redis is down are queued by ioredis and replayed on recovery — the
    // in-memory fallback below guarantees nothing is silently dropped either.
    redisClient = require('../config/redis').getRedisConnection(config);
  } catch (_e) {
    // Redis unavailable fallback
  }
}

// In-memory fallback store
const inMemoryDlq = new Map();

/**
 * @typedef {Object} DeadLetterRecord
 * @property {string} id - Unique identifier for the DLQ entry (e.g. 'dlq_1700000000000_abc123').
 * @property {string} originalJobId - Job ID in the source BullMQ queue.
 * @property {string} queueName - Name of the originating BullMQ queue.
 * @property {string} jobName - Name of the job type/handler.
 * @property {string} sender - Redacted sender phone number or account address.
 * @property {string | null} whatsappMessageId - WhatsApp message ID or original reference.
 * @property {string} failureReason - Error message/reason for failure with sensitive values redacted.
 * @property {number} attempts - Number of retry attempts made before moving to DLQ.
 * @property {string} failedAt - ISO timestamp when the job failed and was moved to DLQ.
 * @property {Record<string, unknown>} payload - Sanitized payload safe for operator viewing.
 * @property {Record<string, unknown>} [rawPayload] - Unsanitized original payload preserved for replay.
 * @property {'pending' | 'replayed' | 'discarded'} status - Current lifecycle status of the DLQ record.
 * @property {string} [replayedAt] - ISO timestamp when the job was replayed.
 * @property {string} [discardedAt] - ISO timestamp when the job was discarded.
 */

/**
 * Redact sensitive fields (PINs, secrets, tokens, passwords) in a payload object
 * before storing in DLQ or returning to an operator.
 *
 * @param {Record<string, unknown> | null | undefined} data - Payload object to sanitize.
 * @returns {Record<string, unknown>} A new object with sensitive fields replaced with '[REDACTED]' and PII redacted.
 *
 * @example
 * const safe = sanitizePayload({ pin: '1234', from: '+2348012345678', note: 'Coffee' });
 * // => { pin: '[REDACTED]', from: '***5678', note: 'Coffee' }
 */
function sanitizePayload(data) {
  if (!data || typeof data !== 'object') return {};
  const copy = { ...data };
  for (const key of Object.keys(copy)) {
    if (/pin|secret|token|password|auth/i.test(key)) {
      copy[key] = '[REDACTED]';
    } else if (typeof copy[key] === 'string') {
      copy[key] = redact(copy[key]);
    }
  }
  return copy;
}

/**
 * Save DLQ record to Redis and/or in-memory store.
 *
 * @private
 * @param {DeadLetterRecord} record - DLQ record to persist.
 * @returns {Promise<void>}
 */
async function saveDlqRecord(record) {
  inMemoryDlq.set(record.id, record);
  if (redisClient) {
    try {
      await redisClient.set(`whatsapp:dlq:${record.id}`, JSON.stringify(record));
      await redisClient.sadd('whatsapp:dlq:ids', record.id);
    } catch (err) {
      logger.error('dlq_redis_save_error', { id: record.id, error: err.message });
    }
  }
}

/**
 * Move an exhausted failed WhatsApp/queue job to the Dead-Letter Queue.
 *
 * @param {Object} job - The BullMQ job that failed and exhausted its retries.
 * @param {string | number} [job.id] - Original BullMQ job identifier.
 * @param {string} [job.name] - Job name/handler type.
 * @param {Record<string, any>} [job.data] - Original job payload data.
 * @param {number} [job.attemptsMade] - Number of attempts made before final failure.
 * @param {Error | string} error - Error or message that caused the final failure.
 * @param {Object} [options] - Additional options.
 * @param {string} [options.queueName='whatsapp-inbound'] - Originating queue name.
 * @returns {Promise<DeadLetterRecord>} The newly created DLQ record.
 *
 * @example
 * const record = await moveToDeadLetterQueue(job, new Error('Network timeout'), {
 *   queueName: 'whatsapp-inbound',
 * });
 */
async function moveToDeadLetterQueue(job, error, options = {}) {
  const queueName = options.queueName || 'whatsapp-inbound';
  const rawId = job.id || crypto.randomUUID().slice(0, 8);
  const dlqId = `dlq_${Date.now()}_${rawId}`;

  const record = {
    id: dlqId,
    originalJobId: String(rawId),
    queueName,
    jobName: job.name || 'processInboundMessage',
    sender: redact(String(job.data?.from || job.data?.recipient || '')),
    whatsappMessageId: job.data?.whatsappMessageId || job.id || null,
    failureReason: redact(error?.message || String(error || 'Unknown job failure')),
    attempts: job.attemptsMade || 3,
    failedAt: new Date().toISOString(),
    payload: sanitizePayload(job.data || {}),
    rawPayload: job.data || {},
    status: 'pending',
  };

  await saveDlqRecord(record);
  logger.error('whatsapp_job_moved_to_dlq', {
    dlqId: record.id,
    originalJobId: record.originalJobId,
    whatsappMessageId: record.whatsappMessageId,
    queueName: record.queueName,
    reason: record.failureReason,
  });

  return record;
}

/**
 * List DLQ jobs for operator inspection with all PII and sensitive fields redacted.
 *
 * @param {Object} [options] - Filtering and pagination options.
 * @param {'pending' | 'replayed' | 'discarded'} [options.status] - Filter by status.
 * @param {number} [options.limit=50] - Maximum number of records to return.
 * @returns {Promise<Array<Omit<DeadLetterRecord, 'rawPayload'>>>} Array of sanitized DLQ records sorted newest first.
 *
 * @example
 * const pendingJobs = await listDeadLetterJobs({ status: 'pending', limit: 25 });
 */
async function listDeadLetterJobs(options = {}) {
  const { status, limit = 50 } = options;
  const records = [];

  if (redisClient) {
    try {
      const ids = await redisClient.smembers('whatsapp:dlq:ids');
      for (const id of ids) {
        const raw = await redisClient.get(`whatsapp:dlq:${id}`);
        if (raw) {
          records.push(JSON.parse(raw));
        }
      }
    } catch (err) {
      logger.error('dlq_redis_list_error', { error: err.message });
    }
  }

  // Merge with in-memory records
  for (const record of inMemoryDlq.values()) {
    if (!records.some((r) => r.id === record.id)) {
      records.push(record);
    }
  }

  let filtered = records;
  if (status) {
    filtered = filtered.filter((r) => r.status === status);
  }

  filtered.sort((a, b) => new Date(b.failedAt).getTime() - new Date(a.failedAt).getTime());
  filtered = filtered.slice(0, limit);

  // Return redacted copies
  return filtered.map((r) => ({
    id: r.id,
    originalJobId: r.originalJobId,
    queueName: r.queueName,
    jobName: r.jobName,
    sender: redact(r.sender),
    whatsappMessageId: r.whatsappMessageId,
    failureReason: redact(r.failureReason),
    attempts: r.attempts,
    failedAt: r.failedAt,
    payload: sanitizePayload(r.payload),
    status: r.status,
  }));
}

/**
 * Get a specific DLQ job by its unique DLQ identifier.
 *
 * @param {string} dlqJobId - The DLQ record ID (e.g. 'dlq_1700000000000_abc123').
 * @returns {Promise<DeadLetterRecord | null>} The full DLQ record or null if not found.
 *
 * @example
 * const job = await getDeadLetterJob('dlq_1700000000000_abc123');
 * if (job) console.log(job.failureReason);
 */
async function getDeadLetterJob(dlqJobId) {
  if (redisClient) {
    try {
      const raw = await redisClient.get(`whatsapp:dlq:${dlqJobId}`);
      if (raw) return JSON.parse(raw);
    } catch (_e) {
      // fallback
    }
  }
  return inMemoryDlq.get(dlqJobId) || null;
}

/**
 * Replay a failed DLQ job with idempotency protection and audit logging.
 * Checks whether the WhatsApp message ID has already been completed in the database
 * to prevent duplicate payment execution.
 *
 * @param {string} dlqJobId - Unique DLQ record identifier to replay.
 * @param {Object} [options] - Replay configuration and audit metadata.
 * @param {Object} [options.queueService] - Queue service instance providing an `enqueue` method.
 * @param {string} [options.actorType='operator'] - Actor type triggering replay (e.g. 'operator', 'admin', 'system').
 * @param {string} [options.actorId='dlq-operator-cli'] - ID of actor triggering the replay for audit records.
 * @returns {Promise<{ replayed: boolean, record: DeadLetterRecord, alreadyCompleted?: boolean, reason?: string }>}
 * @throws {Error} If the specified `dlqJobId` does not exist.
 *
 * @example
 * try {
 *   const res = await replayDeadLetterJob('dlq_1700000000000_abc123', {
 *     queueService,
 *     actorId: 'operator_45',
 *   });
 *   if (res.replayed) console.log('Successfully re-enqueued for replay');
 * } catch (err) {
 *   console.error('Replay failed:', err.message);
 * }
 */
async function replayDeadLetterJob(dlqJobId, options = {}) {
  const { queueService } = options;
  const record = await getDeadLetterJob(dlqJobId);

  if (!record) {
    throw new Error(`DLQ record not found: ${dlqJobId}`);
  }

  if (record.status === 'replayed') {
    return {
      replayed: false,
      reason: 'Job has already been replayed.',
      record,
    };
  }

  // Idempotency check: verify if whatsappMessageId has already been completed in Prisma DB
  if (record.whatsappMessageId) {
    try {
      const db = getPrisma();
      if (db && db.processedMessage) {
        const processed = await db.processedMessage.findUnique({
          where: { messageId: record.whatsappMessageId },
        });
        if (processed && processed.status === 'completed') {
          record.status = 'replayed';
          await saveDlqRecord(record);
          return {
            replayed: false,
            alreadyCompleted: true,
            reason: `Message ${record.whatsappMessageId} was already successfully processed in system. Duplicate payment execution prevented.`,
            record,
          };
        }
      }
    } catch (_err) {
      // Non-fatal if database is unconfigured or in-memory test
    }
  }

  // Re-enqueue job if queueService is available
  if (queueService && typeof queueService.enqueue === 'function') {
    await queueService.enqueue(
      record.queueName,
      record.jobName,
      { ...record.rawPayload, isReplay: true },
      { jobId: record.whatsappMessageId || record.originalJobId },
    );
  }

  record.status = 'replayed';
  record.replayedAt = new Date().toISOString();
  await saveDlqRecord(record);

  // Write audit log entry
  try {
    const db = getPrisma();
    if (db && db.auditLog) {
      await db.auditLog.create({
        data: {
          actorType: options.actorType || 'operator',
          actorId: options.actorId || 'dlq-operator-cli',
          action: 'whatsapp.dlq.replayed',
          entityType: 'DeadLetterJob',
          entityId: dlqJobId,
          metadata: {
            whatsappMessageId: record.whatsappMessageId,
            queueName: record.queueName,
            sender: redact(record.sender),
          },
        },
      });
    }
  } catch (_e) {
    // Non-fatal if audit database is unavailable
  }

  return {
    replayed: true,
    record,
  };
}

/**
 * Discard/archive a DLQ job without replaying it.
 *
 * @param {string} dlqJobId - Unique DLQ record identifier to discard.
 * @param {Object} [_options={}] - Additional options for discard operation.
 * @returns {Promise<{ discarded: true, record: DeadLetterRecord }>}
 * @throws {Error} If the specified `dlqJobId` does not exist.
 *
 * @example
 * const res = await discardDeadLetterJob('dlq_1700000000000_abc123');
 * console.log('Discarded status:', res.record.status);
 */
async function discardDeadLetterJob(dlqJobId, _options = {}) {
  const record = await getDeadLetterJob(dlqJobId);
  if (!record) {
    throw new Error(`DLQ record not found: ${dlqJobId}`);
  }
  record.status = 'discarded';
  record.discardedAt = new Date().toISOString();
  await saveDlqRecord(record);
  return { discarded: true, record };
}

/**
 * Clear all DLQ state from memory and Redis (primarily used for test cleanup).
 *
 * @returns {Promise<void>}
 *
 * @example
 * beforeEach(async () => {
 *   await clearDlq();
 * });
 */
async function clearDlq() {
  inMemoryDlq.clear();
  if (redisClient) {
    try {
      const ids = await redisClient.smembers('whatsapp:dlq:ids');
      if (ids.length > 0) {
        const keys = ids.map((id) => `whatsapp:dlq:${id}`);
        await redisClient.del(...keys, 'whatsapp:dlq:ids');
      }
    } catch (_e) {
      //
    }
  }
}

module.exports = {
  moveToDeadLetterQueue,
  listDeadLetterJobs,
  getDeadLetterJob,
  replayDeadLetterJob,
  discardDeadLetterJob,
  clearDlq,
  sanitizePayload,
};
