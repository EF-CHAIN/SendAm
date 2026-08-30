'use strict';

// Centralized Redis connection policy for SendAm.
//
// Queues (BullMQ), the WhatsApp dead-letter queue and per-sender ordering all
// depend on Redis. Before this module every caller built its own ioredis
// client with its own (often implicit) options, so a Redis outage produced
// inconsistent behaviour and — worse — visible progress could be lost without
// any metric or alert firing.
//
// This module is the single place that decides HOW to talk to Redis:
//   * TLS from a `rediss://` URL, REDIS_CA, or REDIS_TLS=true
//   * exponential reconnect backoff (bounded by REDIS_RETRY_MAX_RECONNECTS)
//   * connect/command timeouts
//   * Sentinel topology support for automatic failover
//
// and exposes a shared, lazily-initialized connection plus a status tracker
// that turns disconnect / reconnect / ready / failover into Prometheus metrics
// and actionable operator logs.

const logger = require('../utils/logger');
const { increment, setGauge, observeDuration } = require('../observability/metrics');
const { captureException } = require('../observability/errors');

let IORedis;
try {
  IORedis = require('ioredis');
} catch (_error) {
  IORedis = null;
}

const DEFAULTS = {
  connectTimeoutMs: 10000,
  commandTimeoutMs: 2000,
  retryMinMs: 250,
  retryMaxMs: 8000,
  maxReconnects: Infinity,
  enableReadyCheck: true,
  keepAliveMs: 30000,
  maxRetriesPerRequest: null,
};

// ---- configuration helpers (pure, unit-testable) --------------------------

const buildTlsOptions = (redis) => {
  if (redis?.tls) return redis.tls;
  if (redis?.ca) return { ca: redis.ca, rejectUnauthorized: true };
  if (redis?.url && redis.url.startsWith('rediss:')) return { rejectUnauthorized: true };
  return undefined;
};

const buildSentinelOptions = (redis) => {
  const rawHosts = (redis?.sentinelHosts || '').split(',').map((h) => h.trim()).filter(Boolean);
  if (!rawHosts.length || !redis?.sentinelMasterName) return null;
  const sentinels = rawHosts.map((hostPort) => {
    const [host, port] = hostPort.split(':');
    return { host, port: port ? Number(port) : 26379 };
  });
  return { sentinels, name: redis.sentinelMasterName };
};

// Exponential backoff. Returns the delay in ms to wait before the `times`-th
// reconnect attempt, or null when the attempt budget is exhausted.
const buildRetryStrategy = (redis = {}, loggerFn = logger.warn.bind(logger)) => {
  const min = Number.isFinite(Number(redis?.retryMinMs)) ? Number(redis.retryMinMs) : DEFAULTS.retryMinMs;
  const max = Number.isFinite(Number(redis?.retryMaxMs)) ? Number(redis.retryMaxMs) : DEFAULTS.retryMaxMs;
  const maxReconnects = Number.isFinite(Number(redis?.maxReconnects))
    ? Number(redis.maxReconnects)
    : DEFAULTS.maxReconnects;

  return (times) => {
    if (maxReconnects !== Infinity && times > maxReconnects) {
      increment('sendam_redis_retries_exhausted_total', {});
      loggerFn('redis_retry_exhausted', { attempt: times, maxReconnects });
      return null; // ioredis stops trying to reconnect after this
    }
    const delay = Math.min(max, min * 2 ** (times - 1));
    return Math.round(delay);
  };
};

const buildConnectionOptions = (redis = {}) => ({
  maxRetriesPerRequest: DEFAULTS.maxRetriesPerRequest,
  connectTimeout: Number(Math.max(1, Number(redis.connectTimeoutMs) || DEFAULTS.connectTimeoutMs)),
  commandTimeout: Number(Math.max(1, Number(redis.commandTimeoutMs) || DEFAULTS.commandTimeoutMs)),
  enableReadyCheck: redis?.enableReadyCheck === false ? false : DEFAULTS.enableReadyCheck,
  keepAlive: Number(Number(redis?.keepAliveMs) || DEFAULTS.keepAliveMs),
  password: redis?.password || undefined,
  tls: buildTlsOptions(redis),
  retryStrategy: buildRetryStrategy(redis),
  lazyConnect: true,
});

// ---- status tracker --------------------------------------------------------
// Tracks in-process connection state and emits a metric/alert per transition.
// Exposed so tests can drive fake clients through disconnect / failover /
// recovery and assert on the resulting metrics.

const createStatusTracker = (redisLabel = 'default') => {
  const state = {
    status: 'disconnected', // disconnected | connecting | connected | ready
    node: null,
    connectedAt: null,
    disconnectedAt: null,
    lastEndpoint: null,
  };

  const setStatus = (next, { node } = {}) => {
    const prev = state.status;
    state.status = next;
    if (node) state.node = node;
    setGauge('sendam_redis_status', next === 'ready' || next === 'connected' ? 1 : 0, { redis: redisLabel });
    return prev;
  };

  const onConnect = (node) => {
    const prev = setStatus('connected', { node });
    if (prev === 'disconnected') {
      // A fresh (re)connect after being fully down → count as a recovery.
      increment('sendam_redis_ready_total', { redis: redisLabel, type: 'reconnect' });
      logger.warn('redis_reconnected', { redis: redisLabel, node: node || null });
    } else {
      increment('sendam_redis_ready_total', { redis: redisLabel, type: 'first' });
      logger.info('redis_connected', { redis: redisLabel, node: node || null });
    }
  };

  const onReady = (node) => {
    setStatus('ready', { node });
    // Failover: a `ready` arriving on a different node than the one that was
    // last serving traffic means Sentinel promoted a new master.
    if (state.lastEndpoint && node && node !== state.lastEndpoint) {
      onFailover(node);
    }
    state.lastEndpoint = node;
    // Recovery: only count as "recovered" when we are coming back after a real
    // disconnect; a clean first connect is not a recovery.
    if (state.disconnectedAt) {
      increment('sendam_redis_disconnect_recovered_total', { redis: redisLabel });
      observeDuration('sendam_redis_recovery_seconds', { redis: redisLabel }, recoveryDurationSeconds());
    }
  };

  const onReconnecting = (delayMs, attempt) => {
    setStatus('connecting');
    increment('sendam_redis_reconnects_total', { redis: redisLabel });
    logger.warn('redis_reconnecting', {
      redis: redisLabel,
      attempt,
      delayMs: Math.round(Number(delayMs) || 0),
    });
  };

  const onError = (error) => {
    increment('sendam_redis_errors_total', { redis: redisLabel });
    logger.error('redis_error', { redis: redisLabel, message: error?.message || String(error) });
    captureException(error, { source: 'redis', redis: redisLabel });
  };

  const onDisconnected = (endpoint, reason) => {
    const prev = setStatus('disconnected', { node: endpoint || null });
    if (prev === 'ready' || prev === 'connected') {
      increment('sendam_redis_disconnects_total', { redis: redisLabel, reason: reason || 'close' });
      state.disconnectedAt = Date.now();
      logger.error('redis_disconnected', { redis: redisLabel, endpoint: endpoint || null, reason: reason || 'close' });
    }
  };

  const onFailover = (node) => {
    increment('sendam_redis_failovers_total', { redis: redisLabel });
    state.node = node;
    logger.warn('redis_failover', { redis: redisLabel, node: node || null });
  };

  const recoveryDurationSeconds = () => {
    if (!state.disconnectedAt) return 0;
    const dur = (Date.now() - state.disconnectedAt) / 1000;
    return Math.max(0, dur);
  };

  return {
    state,
    onConnect,
    onReady,
    onReconnecting,
    onError,
    onDisconnected,
    onFailover,
    setStatus,
  };
};

// Attach every go-around to a client. In a Sentinel topology ioredis emits
// `ready` on the node it is currently master of; the tracker turns that into
// failover (when the ready endpoint changes) and recovery (returning to
// serving traffic after a disconnect) metrics itself, so the behaviour is
// identical whether the client is wired here or driven directly (tests).
const attachRedisEvents = (client, tracker) => {
  client.on('connect', () => tracker.onConnect(client.options?.host));
  client.on('ready', () => tracker.onReady(client.options?.host));
  client.on('reconnecting', (delayMs, attempt) => tracker.onReconnecting(delayMs, attempt));
  client.on('error', (error) => tracker.onError(error));
  client.on('close', () => tracker.onDisconnected(`${client.options?.host}:${client.options?.port}`, 'close'));
  client.on('end', () => tracker.onDisconnected(`${client.options?.host}:${client.options?.port}`, 'end'));
  return client;
};

// ---- shared connection -----------------------------------------------------

let sharedConnection = null;
let sharedTracker = null;

// Returns the process-wide Redis connection, creating it on first use with the
// configured policy. Returns null when Redis is not configured (dev/test) or
// ioredis is not installed.
const getRedisConnection = (config, redisLabel = 'default') => {
  if (sharedConnection) return sharedConnection;

  const redisConfig = config?.redis || {};
  if (!IORedis || !redisConfig.url) return null;

  sharedTracker = createStatusTracker(redisLabel);
  const sentinel = buildSentinelOptions(redisConfig);
  const connection = new IORedis(redisConfig.url, {
    ...buildConnectionOptions(redisConfig),
    ...(sentinel ? sentinel : {}),
  });
  attachRedisEvents(connection, sharedTracker);
  sharedConnection = connection;
  connection.connect().catch((error) => {
    // Initial dial failure (or redis down at boot). ioredis keeps retrying via
    // retryStrategy; just record it so operators see a clear alert, then let
    // the reconnect cycle take over.
    logger.error('redis_initial_connect_failed', { message: error?.message || String(error) });
  });
  return sharedConnection;
};

const getRedisStatus = () => (
  sharedTracker ? sharedTracker.state : { status: sharedConnection ? 'ready' : 'unconfigured' }
);

const redisIsAvailable = () => (
  Boolean(sharedConnection) && (sharedTracker ? sharedTracker.state.status === 'ready' : true)
);

// Testing and shutdown helper: fully tear down the shared connection.
const resetRedisConnection = async () => {
  if (sharedConnection) {
    try {
      await sharedConnection.quit();
    } catch (_error) {
      // ignore
    }
  }
  sharedConnection = null;
  sharedTracker = null;
};

module.exports = {
  getRedisConnection,
  getRedisStatus,
  redisIsAvailable,
  resetRedisConnection,
  createStatusTracker,
  attachRedisEvents,
  buildTlsOptions,
  buildSentinelOptions,
  buildRetryStrategy,
  buildConnectionOptions,
};
