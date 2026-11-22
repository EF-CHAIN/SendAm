const config = require('../config/env');
const { getRedisConnection } = require('../config/redis');
const logger = require('../utils/logger');

const CONVERSATION_WINDOW_MS = 24 * 60 * 60 * 1000;
const KEY_PREFIX = 'whatsapp:last_inbound:';
const KEY_TTL_SECONDS = 25 * 60 * 60; // 25 hours (slightly longer than 24h window)

function getKey(phoneNumber) {
  return `${KEY_PREFIX}${phoneNumber}`;
}

async function getRedis() {
  const redis = getRedisConnection(config);
  if (!redis) return null;
  if (!redis.status || redis.status !== 'ready') {
    try {
      await redis.connect();
    } catch (_error) {
      return null;
    }
  }
  return redis;
}

async function setLastInboundAt(phoneNumber) {
  const redis = await getRedis();
  if (!redis) {
    logger.warn('redis_unavailable_skip_last_inbound_set', { phoneNumber });
    return false;
  }

  const key = getKey(phoneNumber);
  const timestamp = Date.now().toString();

  try {
    await redis.setex(key, KEY_TTL_SECONDS, timestamp);
    logger.debug('last_inbound_at_set', { phoneNumber });
    return true;
  } catch (error) {
    logger.error('last_inbound_at_set_failed', { phoneNumber, message: error.message });
    return false;
  }
}

async function getLastInboundAt(phoneNumber) {
  const redis = await getRedis();
  if (!redis) return null;

  const key = getKey(phoneNumber);

  try {
    const value = await redis.get(key);
    if (!value) return null;
    const timestamp = parseInt(value, 10);
    if (Number.isNaN(timestamp)) return null;
    return new Date(timestamp);
  } catch (error) {
    logger.error('last_inbound_at_get_failed', { phoneNumber, message: error.message });
    return null;
  }
}

function isWithinConversationWindow(lastInboundAt) {
  if (!lastInboundAt) return false;
  const lastTime = lastInboundAt.getTime();
  if (Number.isNaN(lastTime)) return false;
  return Date.now() - lastTime <= CONVERSATION_WINDOW_MS;
}

async function checkAndSetTemplateFallback(phoneNumber, templateName, languageCode = 'en') {
  const lastInboundAt = await getLastInboundAt(phoneNumber);
  const withinWindow = isWithinConversationWindow(lastInboundAt);

  return {
    withinWindow,
    lastInboundAt,
    shouldUseTemplate: !withinWindow,
    templateName: withinWindow ? null : templateName,
  };
}

module.exports = {
  CONVERSATION_WINDOW_MS,
  setLastInboundAt,
  getLastInboundAt,
  isWithinConversationWindow,
  checkAndSetTemplateFallback,
  KEY_PREFIX,
};