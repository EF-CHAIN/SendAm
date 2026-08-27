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

let IORedis;
let redisClient;

if (config.redis && config.redis.url) {
  try {
    IORedis = require('ioredis');
    redisClient = new IORedis(config.redis.url, { maxRetriesPerRequest: null });
    redisClient.on('error', (err) => logger.error('dlq_redis_error', { message: err.message }));
  } catch (_e) {
    // Redis unavailable fallback
  }
}

// In-memory fallback store
const inMemoryDlq = new Map();

/**
 * Redact sensitive fields in payload before storing in DLQ or returning to operator.
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
 * Clear DLQ state (testing helper)
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
  clearDlq,
  sanitizePayload,
};
