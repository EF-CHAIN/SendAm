'use strict';

// Meta 24-hour customer care window tracker (#969).
//
// Meta only accepts free-form messages within 24h of the user's last inbound
// message; outside that window only approved templates are delivered. The
// last inbound time is kept in Redis (shared by every API/worker instance) and
// read on the outbound path by whatsapp.service#sendTextMessage.
//
// Redis is an optimisation, never a dependency: when it is unavailable or slow
// every function degrades to "unknown" (null/false) within REDIS_TIMEOUT_MS
// instead of throwing or blocking a send.

const config = require('../config/env');
const { getRedisConnection } = require('../config/redis');
const logger = require('../utils/logger');

const CONVERSATION_WINDOW_MS = 24 * 60 * 60 * 1000;
const KEY_PREFIX = 'whatsapp:last_inbound:';
const KEY_TTL_SECONDS = 25 * 60 * 60; // a little longer than the window itself
const REDIS_TIMEOUT_MS = 500;

// Inbound webhooks carry Meta's wa_id ("2348012345678"); outbound callers use
// E.164 ("+2348012345678"). Key on digits only so both resolve to one entry.
const normalizePhone = (phoneNumber) => String(phoneNumber || '').replace(/\D/g, '');

const getKey = (phoneNumber) => `${KEY_PREFIX}${normalizePhone(phoneNumber)}`;

// The shared connection dials itself (config/redis). Only use it once ready:
// commands issued while it is (re)connecting are queued with no retry limit,
// which would stall the send path during an outage.
const defaultRedis = () => {
  const redis = getRedisConnection(config);
  if (!redis || redis.status !== 'ready') return null;
  return redis;
};

const withTimeout = (promise) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('redis_timeout')), REDIS_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const toDate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** Accepts a Date, ISO string or epoch ms (job payloads arrive JSON-serialized). */
const isWithinConversationWindow = (lastInboundAt, now = Date.now()) => {
  const date = toDate(lastInboundAt);
  if (!date) return false;
  return now - date.getTime() <= CONVERSATION_WINDOW_MS;
};

const setLastInboundAt = async (phoneNumber, { redis = defaultRedis(), now = Date.now() } = {}) => {
  if (!normalizePhone(phoneNumber)) return false;
  if (!redis) {
    logger.warn('whatsapp_last_inbound_skipped_redis_unavailable');
    return false;
  }
  try {
    await withTimeout(redis.set(getKey(phoneNumber), String(now), 'EX', KEY_TTL_SECONDS));
    return true;
  } catch (error) {
    logger.warn('whatsapp_last_inbound_set_failed', { message: error.message });
    return false;
  }
};

const getLastInboundAt = async (phoneNumber, { redis = defaultRedis() } = {}) => {
  if (!redis || !normalizePhone(phoneNumber)) return null;
  try {
    const value = await withTimeout(redis.get(getKey(phoneNumber)));
    if (!value) return null;
    return toDate(Number(value));
  } catch (error) {
    logger.warn('whatsapp_last_inbound_get_failed', { message: error.message });
    return null;
  }
};

/**
 * The most recent known inbound time for a recipient: the Redis value or the
 * caller-supplied fallback (e.g. User.lastCustomerInteractionAt), whichever is
 * later. Returns null when neither is known.
 */
const resolveLastInboundAt = async (phoneNumber, fallback = null, options = {}) => {
  const fromRedis = await getLastInboundAt(phoneNumber, options);
  const fromFallback = toDate(fallback);
  if (!fromRedis) return fromFallback;
  if (!fromFallback) return fromRedis;
  return fromRedis > fromFallback ? fromRedis : fromFallback;
};

module.exports = {
  CONVERSATION_WINDOW_MS,
  KEY_PREFIX,
  KEY_TTL_SECONDS,
  normalizePhone,
  getKey,
  isWithinConversationWindow,
  setLastInboundAt,
  getLastInboundAt,
  resolveLastInboundAt,
};
