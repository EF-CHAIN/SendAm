const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTlsOptions,
  buildSentinelOptions,
  buildRetryStrategy,
  buildConnectionOptions,
  createStatusTracker,
  attachRedisEvents,
  resetRedisConnection,
} = require('../src/config/redis');
const { renderMetrics, resetMetrics } = require('../src/observability/metrics');

beforeEach(() => {
  resetMetrics();
  resetRedisConnection();
});

const metricValue = (base, labels = {}) => {
  const body = renderMetrics();
  const labelText = Object.keys(labels).length
    ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}`
    : '';
  const pattern = new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${labelText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ([0-9.e+]+)`);
  const match = body.match(pattern);
  return match ? Number(match[1]) : 0;
};

const metricExists = (base) => renderMetrics().includes(base);

// ---- TLS / topology / backoff / timeout configuration -----------------------

test('buildTlsOptions enables rejectUnauthorized for a rediss:// URL', () => {
  assert.deepEqual(buildTlsOptions({ url: 'rediss://example.com:6379' }), { rejectUnauthorized: true });
});

test('buildTlsOptions enables rejectUnauthorized from a CA without requiring rediss://', () => {
  assert.deepEqual(buildTlsOptions({ ca: 'PEM' }), { ca: 'PEM', rejectUnauthorized: true });
});

test('buildTlsOptions prefers an explicit REDIS_TLS block when present', () => {
  assert.deepEqual(buildTlsOptions({ tls: { rejectUnauthorized: false } }), { rejectUnauthorized: false });
});

test('buildTlsOptions returns undefined for a plain redis:// URL', () => {
  assert.equal(buildTlsOptions({ url: 'redis://localhost:6379' }), undefined);
});

test('buildSentinelOptions returns null without hosts or a master name', () => {
  assert.equal(buildSentinelOptions({}), null);
  assert.equal(buildSentinelOptions({ sentinelHosts: 'a:26379,b:26379' }), null);
  assert.equal(buildSentinelOptions({ sentinelMasterName: 'mymaster' }), null);
});

test('buildSentinelOptions maps sentinel hosts and master name into ioredis topology options', () => {
  const opts = buildSentinelOptions({ sentinelHosts: 'h1:26379, h2:26379', sentinelMasterName: 'mymaster' });
  assert.deepEqual(opts, {
    sentinels: [{ host: 'h1', port: 26379 }, { host: 'h2', port: 26379 }],
    name: 'mymaster',
  });
});

test('buildRetryStrategy applies exponential backoff capped at the maximum', () => {
  const calls = [];
  const strategy = buildRetryStrategy({ retryMinMs: 100, retryMaxMs: 800 }, (msg, p) => calls.push(p));
  assert.equal(strategy(1), 100);
  assert.equal(strategy(2), 200);
  assert.equal(strategy(3), 400);
  assert.equal(strategy(4), 800);
  assert.equal(strategy(5), 800, 'backoff must not exceed the configured maximum');
});

test('buildRetryStrategy stops reconnecting once the attempt budget is exhausted', () => {
  const strategy = buildRetryStrategy({ retryMinMs: 100, maxReconnects: 2 }, () => {});
  assert.equal(strategy(1), 100);
  assert.equal(strategy(2), 200);
  assert.equal(strategy(3), null, 'must stop after the configured max reconnects');
});

test('buildConnectionOptions wires timeouts, ready check, keepalive, and a retry strategy', () => {
  const opts = buildConnectionOptions({
    url: 'redis://localhost:6379',
    connectTimeoutMs: 5000,
    commandTimeoutMs: 1000,
    retryMinMs: 50,
    retryMaxMs: 1000,
    keepAliveMs: 15000,
    enableReadyCheck: true,
  });
  assert.equal(opts.connectTimeout, 5000);
  assert.equal(opts.commandTimeout, 1000);
  assert.equal(opts.keepAlive, 15000);
  assert.equal(opts.enableReadyCheck, true);
  assert.equal(opts.lazyConnect, true);
  assert.equal(typeof opts.retryStrategy, 'function');
});

// ---- disconnect / failover / recovery metrics -------------------------------

const fakeClient = (host = 'redis-a') => {
  const handlers = {};
  const client = {
    options: { host, port: 6379 },
    on(event, handler) { handlers[event] = handler; return client; },
  };
  return { client, handlers };
};

test('status tracker surfaces a fully-down Redis as disconnected and emits recovery on reconnect', () => {
  const tracker = createStatusTracker('primary');
  // Initial failed dial
  tracker.onConnect('redis-a');      // connected
  tracker.onDisconnected('redis-a:6379', 'close'); // unexpected drop -> disconnect metric
  assert.equal(tracker.state.status, 'disconnected');

  // Recovery
  tracker.onReconnecting(200, 1);
  tracker.onConnect('redis-a');
  tracker.onReady('redis-a');

  assert.equal(tracker.state.status, 'ready');
  assert.ok(metricValue('sendam_redis_disconnects_total', { redis: 'primary', reason: 'close' }) >= 1);
  assert.ok(metricValue('sendam_redis_disconnect_recovered_total', { redis: 'primary' }) >= 1);
  assert.ok(metricValue('sendam_redis_reconnects_total', { redis: 'primary' }) >= 1);
  assert.ok(metricExists('sendam_redis_recovery_seconds_count'));
  assert.ok(metricExists('sendam_redis_status'));
});

test('status tracker records a failover when ready arrives on a different endpoint after a drop', () => {
  const tracker = createStatusTracker('primary');
  tracker.onConnect('redis-a');
  tracker.onReady('redis-a');
  tracker.onDisconnected('redis-a:6379', 'close');
  // Failover: recovered onto a new master node
  tracker.onConnect('redis-b');
  tracker.onReady('redis-b');

  assert.ok(metricValue('sendam_redis_failovers_total', { redis: 'primary' }) >= 1, 'failover metric must increment');
  assert.equal(tracker.state.node, 'redis-b');
});

test('attachRedisEvents wires every lifecycle transition to the tracker', () => {
  const { client, handlers } = fakeClient('redis-a');
  const tracker = createStatusTracker('primary');
  attachRedisEvents(client, tracker);

  handlers.connect();
  handlers.ready();
  handlers.reconnecting(250, 1);
  handlers.close();
  handlers.error(new Error('boom'));

  assert.equal(tracker.state.status, 'disconnected');
  assert.ok(metricValue('sendam_redis_reconnects_total', { redis: 'primary' }) >= 1);
  assert.ok(metricExists('sendam_redis_error'));
});

test('a first-time connect does not count as a disconnect/recovery transition', () => {
  const tracker = createStatusTracker('primary');
  tracker.onConnect('redis-a');
  tracker.onReady('redis-a');
  // No disconnect should have been recorded for a clean first connect
  assert.equal(metricValue('sendam_redis_disconnects_total', { redis: 'primary' }), 0);
  assert.equal(metricValue('sendam_redis_disconnect_recovered_total', { redis: 'primary' }), 0);
  assert.equal(tracker.state.status, 'ready');
});
