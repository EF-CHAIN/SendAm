'use strict';

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
 * @file dlq.service.js
 * @description Dead-Letter Queue (DLQ) service for storing, inspecting, replaying,
 * and discarding failed background jobs (e.g. WhatsApp inbound messages) with PII redaction
 * and idempotency checks.
 *
 * @example
 * // 1. Moving a failed job to DLQ:
 * const dlqRecord = await moveToDeadLetterQueue(job, error, { queueName: 'whatsapp-inbound' });
 *
 * // 2. Listing failed jobs for operator review:
 * const failedJobs = await listDeadLetterJobs({ status: 'pending', limit: 20 });
 *
 * // 3. Replaying a job with idempotency guards:
 * const result = await replayDeadLetterJob(dlqRecord.id, { queueService, actorId: 'admin-1' });
 */

/**
 * Redact sensitive fields in payload before storing in DLQ or returning to operator.
 * Masks known authentication keys (PIN, token, secret, password) and redacts PII strings.
 *
 * @param {Record<string, any>} data - Raw payload object to sanitize.
 * @returns {Record<string, any>} Sanitized payload copy with sensitive fields masked.
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
 * @param {object} record - DLQ record object to persist.
 * @returns {Promise<void>} Resolves when saved.
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
 * Move an exhausted failed WhatsApp job to the Dead-Letter Queue.
 *
 * @param {object} job - The BullMQ / worker job object that failed.
 * @param {string|number} [job.id] - Original job identifier.
 * @param {string} [job.name] - Name of the job / handler.
 * @param {object} [job.data] - Original job data payload.
 * @param {number} [job.attemptsMade] - Number of attempts made before failing.
 * @param {Error|string} error - The error or exception that caused job failure.
 * @param {object} [options={}] - Additional metadata options.
 * @param {string} [options.queueName='whatsapp-inbound'] - Name of the origin queue.
 * @returns {Promise<object>} The newly created DLQ record.
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
 * List DLQ jobs for operator inspection with PII redacted.
 *
 * @param {object} [options={}] - Query filtering and pagination options.
 * @param {string} [options.status] - Filter by job status ('pending' | 'replayed' | 'discarded').
 * @param {number} [options.limit=50] - Maximum number of records to return.
 * @returns {Promise<Array<object>>} List of DLQ records with sanitized payloads and redacted PII.
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
 * Get a specific DLQ job by ID.
 *
 * @param {string} dlqJobId - DLQ record ID to retrieve.
 * @returns {Promise<object|null>} The DLQ record object or null if not found.
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
 *
 * @param {string} dlqJobId - ID of the DLQ record to replay.
 * @param {object} [options={}] - Replay execution options.
 * @param {object} [options.queueService] - Queue service instance supporting `enqueue(queue, name, data, opts)`.
 * @param {string} [options.actorType='operator'] - Actor type triggering replay for audit log.
 * @param {string} [options.actorId='dlq-operator-cli'] - ID of actor triggering replay.
 * @throws {Error} Throws if the DLQ record does not exist.
 * @returns {Promise<{ replayed: boolean, reason?: string, alreadyCompleted?: boolean, record: object }>} Replay result status and record.
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
 * Discard/archive a DLQ job.
 *
 * @param {string} dlqJobId - ID of the DLQ record to discard.
 * @param {object} [_options={}] - Discard options.
 * @throws {Error} Throws if the DLQ record does not exist.
 * @returns {Promise<{ discarded: boolean, record: object }>} Discard result status and record.
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
 * Clear DLQ state in memory and Redis (testing helper).
 *
 * @returns {Promise<void>} Resolves when DLQ storage is wiped.
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

