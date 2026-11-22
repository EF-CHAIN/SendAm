'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildClusterOptions,
  buildTopologyOptions,
  buildRetryStrategy,
  bullPrefix,
  reconnectOnError,
  startHeartbeat,
} = require('../src/config/redis');

test('buildClusterOptions parses nodes and defaults the port', () => {
  assert.equal(buildClusterOptions({}), null);
  assert.deepEqual(buildClusterOptions({ clusterNodes: 'a:7000, b' }).nodes, [
    { host: 'a', port: 7000 },
    { host: 'b', port: 6379 },
  ]);
});

test('bullPrefix hash-tags queue keys only for cluster topologies', () => {
  assert.equal(bullPrefix({ url: 'redis://x' }), undefined);
  assert.equal(bullPrefix({ clusterNodes: 'a:7000' }), '{bull}');
});

test('topology selection: cluster beats sentinel beats standalone', () => {
  assert.equal(buildTopologyOptions({ url: 'redis://x' }).type, 'standalone');
  const sentinel = buildTopologyOptions({ url: 'redis://x', sentinelHosts: 's1:26379', sentinelMasterName: 'm' });
  assert.equal(sentinel.type, 'sentinel');
  assert.equal(sentinel.options.name, 'm');
  assert.equal(sentinel.options.role, 'master');
  assert.equal(sentinel.options.failoverDetector, true);
  assert.equal(typeof sentinel.options.sentinelRetryStrategy, 'function');
  const cluster = buildTopologyOptions({
    clusterNodes: 'a:7000', sentinelHosts: 's1', sentinelMasterName: 'm', retryMinMs: 100, retryMaxMs: 800,
  });
  assert.equal(cluster.type, 'cluster');
  assert.equal(cluster.options.redisOptions.maxRetriesPerRequest, null, 'required by BullMQ');
  assert.equal(cluster.options.clusterRetryStrategy(3), 400);
});

test('reconnectOnError reconnects and resends on failover errors only', () => {
  assert.equal(reconnectOnError(new Error('READONLY replica cannot accept writes')), 2);
  assert.equal(reconnectOnError(new Error('MASTERDOWN Link with MASTER is down')), 2);
  assert.equal(reconnectOnError(new Error('WRONGTYPE bad type')), false);
});

test('heartbeat forces a reconnect after consecutive failed pings, then recovers', async () => {
  let pingFails = true;
  let disconnects = 0;
  const client = {
    ping: async () => { if (pingFails) throw new Error('down'); return 'PONG'; },
    disconnect: (reconnect) => { assert.equal(reconnect, true); disconnects += 1; },
  };
  const hb = startHeartbeat(client, { intervalMs: 3600000, timeoutMs: 50, maxFailures: 3 });
  try {
    await hb.beat();
    await hb.beat();
    assert.equal(disconnects, 0);
    await hb.beat();
    assert.equal(disconnects, 1);
    pingFails = false;
    await hb.beat();
    pingFails = true;
    await hb.beat();
    await hb.beat();
    assert.equal(disconnects, 1, 'a successful ping resets the failure counter');
  } finally {
    hb.stop();
  }
});

test('heartbeat treats a hung ping as a failure', async () => {
  let disconnects = 0;
  const client = { ping: () => new Promise(() => {}), disconnect: () => { disconnects += 1; } };
  const hb = startHeartbeat(client, { intervalMs: 3600000, timeoutMs: 20, maxFailures: 1 });
  try {
    await hb.beat();
    assert.equal(disconnects, 1);
  } finally {
    hb.stop();
  }
});

test('reconnect backoff stays bounded across a long outage', () => {
  const strategy = buildRetryStrategy({ retryMinMs: 250, retryMaxMs: 8000 });
  assert.equal(strategy(1), 250);
  assert.equal(strategy(100), 8000);
});
