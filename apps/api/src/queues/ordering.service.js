const crypto = require('crypto');
const logger = require('../utils/logger');
const { increment } = require('../observability/metrics');

const DEFAULT_REQUEUE_DELAY_MS = 250;
const DEFAULT_MAX_REQUEUES = 40;
const DEFAULT_LOCK_TTL_MS = 30000;

const canonicalSender = (from) => String(from ?? '').trim();

const createInMemoryOrderingStore = () => {
  const locks = new Map(); // key -> ownerId
  const cursors = new Map();
  return {
    tryAcquire(key, ownerId = 'default-owner') {
      const current = locks.get(key);
      if (current && current !== ownerId) return false;
      locks.set(key, ownerId);
      return true;
    },
    release(key, ownerId = 'default-owner') {
      const current = locks.get(key);
      if (!ownerId || current === ownerId) {
        locks.delete(key);
      }
    },
    getCursor(key) {
      return cursors.get(key) || null;
    },
    advanceCursor(key, cursor) {
      const existing = cursors.get(key);
      if (existing && existing.timestamp > cursor.timestamp) return false;
      if (existing && existing.timestamp === cursor.timestamp && existing.messageId === cursor.messageId) return false;
      cursors.set(key, cursor);
      return true;
    },
    reset() {
      locks.clear();
      cursors.clear();
    },
  };
};

/**
 * Distributed Redis-backed ordering store.
 * Supports lock ownership, TTL expiration (recovering crashed workers), safe lock release,
 * and atomic cursor compare-and-set across replicas and worker restarts.
 */
const createRedisOrderingStore = (options = {}) => {
  const { redis, lockTtlMs = DEFAULT_LOCK_TTL_MS } = options;

  if (!redis) {
    throw new Error('createRedisOrderingStore requires a Redis client instance');
  }

  // Fallback memory store used if Redis commands fail during temporary outage
  const fallback = createInMemoryOrderingStore();

  return {
    async tryAcquire(key, ownerId = crypto.randomUUID()) {
      try {
        const lockKey = `whatsapp:ordering:lock:${key}`;
        // SET key ownerId PX lockTtlMs NX
        const result = await redis.set(lockKey, ownerId, 'PX', lockTtlMs, 'NX');
        if (result === 'OK') return true;

        // Check if lock is already held by this owner
        const currentOwner = await redis.get(lockKey);
        return currentOwner === ownerId;
      } catch (err) {
        logger.error('redis_ordering_store_tryAcquire_error', { key, error: err.message });
        return fallback.tryAcquire(key, ownerId);
      }
    },

    async release(key, ownerId = 'default-owner') {
      try {
        const lockKey = `whatsapp:ordering:lock:${key}`;
        // Safe release via Lua script: delete lock ONLY if ownerId matches
        const luaScript = `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
          else
            return 0
          end
        `;
        await redis.eval(luaScript, 1, lockKey, ownerId);
        fallback.release(key, ownerId);
      } catch (err) {
        logger.error('redis_ordering_store_release_error', { key, error: err.message });
        fallback.release(key, ownerId);
      }
    },

    async getCursor(key) {
      try {
        const cursorKey = `whatsapp:ordering:cursor:${key}`;
        const data = await redis.get(cursorKey);
        if (!data) return fallback.getCursor(key);
        const parsed = JSON.parse(data);
        return { timestamp: Number(parsed.timestamp), messageId: String(parsed.messageId) };
      } catch (err) {
        logger.error('redis_ordering_store_getCursor_error', { key, error: err.message });
        return fallback.getCursor(key);
      }
    },

    async advanceCursor(key, cursor) {
      try {
        const cursorKey = `whatsapp:ordering:cursor:${key}`;
        // Atomic compare-and-set via Lua script
        const luaScript = `
          local current = redis.call("get", KEYS[1])
          local newTs = tonumber(ARGV[1])
          local newId = ARGV[2]
          if current then
            local c = cjson.decode(current)
            if c.timestamp > newTs then
              return 0
            end
            if c.timestamp == newTs and c.messageId == newId then
              return 0
            end
          end
          local val = cjson.encode({ timestamp = newTs, messageId = newId })
          redis.call("set", KEYS[1], val)
          return 1
        `;
        const res = await redis.eval(luaScript, 1, cursorKey, String(cursor.timestamp), String(cursor.messageId));
        fallback.advanceCursor(key, cursor);
        return res === 1;
      } catch (err) {
        logger.error('redis_ordering_store_advanceCursor_error', { key, error: err.message });
        return fallback.advanceCursor(key, cursor);
      }
    },

    async reset() {
      fallback.reset();
      try {
        const lockKeys = await redis.keys('whatsapp:ordering:lock:*');
        const cursorKeys = await redis.keys('whatsapp:ordering:cursor:*');
        const allKeys = [...lockKeys, ...cursorKeys];
        if (allKeys.length > 0) {
          await redis.del(...allKeys);
        }
      } catch (err) {
        logger.error('redis_ordering_store_reset_error', { error: err.message });
      }
    },
  };
};

/**
 * Creates the appropriate ordering store for current environment.
 * Automatically uses Redis if REDIS_URL or redis client is provided.
 */
const createDistributedOrderingStore = (options = {}) => {
  let { redis } = options;
  if (!redis && process.env.REDIS_URL) {
    try {
      const Redis = require('ioredis');
      redis = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });
    } catch {
      // Fallback if ioredis unavailable
    }
  }

  if (redis) {
    return createRedisOrderingStore({ redis, lockTtlMs: options.lockTtlMs });
  }

  return createInMemoryOrderingStore();
};

/**
 * Pure decision function over the store's current state.
 * Supports async or sync store methods.
 */
const evaluateOrdering = async (store, senderKey, providerTimestamp, messageId, ownerId = crypto.randomUUID()) => {
  const cursor = await store.getCursor(senderKey);
  if (cursor) {
    if (providerTimestamp < cursor.timestamp) return { action: 'stale', reason: 'older-than-cursor' };
    if (providerTimestamp === cursor.timestamp && messageId && messageId === cursor.messageId) {
      return { action: 'stale', reason: 'duplicate' };
    }
  }
  const acquired = await store.tryAcquire(senderKey, ownerId);
  if (!acquired) return { action: 'requeue' };
  return { action: 'process', ownerId };
};

/**
 * Wrap a BullMQ-style job processor `(job, token) => Promise<result>` with
 * per-sender ordering across worker restarts and replicas.
 */
const withOrdering = (processor, options = {}) => {
  const {
    store = createDistributedOrderingStore(),
    requeueDelayMs = DEFAULT_REQUEUE_DELAY_MS,
    maxRequeues = DEFAULT_MAX_REQUEUES,
    senderOf = (job) => canonicalSender(job.data?.from),
    timestampOf = (job) => {
      const provided = Number(job.data?.providerTimestamp);
      if (Number.isFinite(provided)) return provided;
      const enqueuedAt = Number(job.timestamp);
      return Number.isFinite(enqueuedAt) ? enqueuedAt : Date.now();
    },
    messageIdOf = (job) => job.data?.whatsappMessageId || job.id,
  } = options;

  return async (job, token) => {
    const senderKey = senderOf(job);
    if (!senderKey) return processor(job, token);

    const providerTimestamp = timestampOf(job);
    const messageId = messageIdOf(job);
    const ownerId = crypto.randomUUID();
    const isDelayableBullMqJob = typeof job.moveToDelayed === 'function';
    let attempt = isDelayableBullMqJob ? Number(job.data?.__orderingRequeueCount || 0) : 0;

    for (;;) {
      const decision = await evaluateOrdering(store, senderKey, providerTimestamp, messageId, ownerId);

      if (decision.action === 'stale') {
        increment('sendam_whatsapp_ordering_violations_total', { reason: decision.reason });
        logger.warn('whatsapp_message_ordering_stale_drop', {
          senderKey, providerTimestamp, messageId, reason: decision.reason,
        });
        return { skipped: true, reason: decision.reason };
      }

      if (decision.action === 'process') {
        try {
          const result = await processor(job, token);
          await store.advanceCursor(senderKey, { timestamp: providerTimestamp, messageId });
          return result;
        } finally {
          await store.release(senderKey, ownerId);
        }
      }

      // decision.action === 'requeue'
      attempt += 1;
      if (attempt > maxRequeues) {
        logger.error('whatsapp_message_ordering_requeue_exhausted', { senderKey, messageId, attempt });
        increment('sendam_whatsapp_ordering_violations_total', { reason: 'requeue-exhausted' });
      }

      if (isDelayableBullMqJob && token) {
        if (typeof job.updateData === 'function') {
          await job.updateData({ ...job.data, __orderingRequeueCount: attempt });
        }
        const { DelayedError } = require('bullmq');
        await job.moveToDelayed(Date.now() + requeueDelayMs, token);
        throw new DelayedError();
      }

      await new Promise((resolve) => setTimeout(resolve, requeueDelayMs));
    }
  };
};

module.exports = {
  canonicalSender,
  createInMemoryOrderingStore,
  createRedisOrderingStore,
  createDistributedOrderingStore,
  evaluateOrdering,
  withOrdering,
  DEFAULT_REQUEUE_DELAY_MS,
  DEFAULT_MAX_REQUEUES,
  DEFAULT_LOCK_TTL_MS,
};

