/**
 * The worker's capacity settings must exist in config, not just in the
 * validator that reads them.
 *
 * `queues/queue.service.js` passes `config.worker.concurrency` and
 * `lockDurationMs` straight to BullMQ, and `worker.js` reads
 * `heartbeatIntervalMs` and `shutdownTimeoutMs` at startup. When the `worker`
 * block was missing from `config/env.js`, every one of those was `undefined`
 * and the worker process could not start — the existing tests did not catch it
 * because they inject a mock config that supplies the block.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const freshConfig = (env = {}) => {
  const configPath = path.resolve(__dirname, '../src/config/env.js');
  delete require.cache[configPath];
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return require(configPath);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[configPath];
  }
};

test('config exposes the worker block the queue service and worker read', () => {
  const config = freshConfig({
    WORKER_CONCURRENCY: undefined,
    WORKER_LOCK_DURATION_MS: undefined,
    WORKER_HEARTBEAT_INTERVAL_MS: undefined,
    WORKER_SHUTDOWN_TIMEOUT_MS: undefined,
  });

  assert.ok(config.worker, 'config.worker must exist');
  assert.equal(typeof config.worker.concurrency, 'number');
  assert.equal(typeof config.worker.lockDurationMs, 'number');
  assert.equal(typeof config.worker.heartbeatIntervalMs, 'number');
  assert.equal(typeof config.worker.shutdownTimeoutMs, 'number');
});

test('the defaults satisfy validateWorkerEnv, so the worker starts with only REDIS_URL set', () => {
  const { validateWorkerEnv } = require('../src/config/validateEnv');
  const config = freshConfig({ REDIS_URL: 'redis://localhost:6379' });
  assert.doesNotThrow(() => validateWorkerEnv(config));
});

test('the defaults respect the validator\'s own lower bounds', () => {
  const config = freshConfig({});
  assert.ok(Number.isInteger(config.worker.concurrency) && config.worker.concurrency >= 1);
  assert.ok(config.worker.lockDurationMs >= 5000, 'BullMQ lock must exceed the validator floor');
});

test('capacity settings are overridable from the environment', () => {
  const config = freshConfig({
    WORKER_CONCURRENCY: '12',
    WORKER_LOCK_DURATION_MS: '45000',
    WORKER_HEARTBEAT_INTERVAL_MS: '10000',
    WORKER_SHUTDOWN_TIMEOUT_MS: '20000',
  });
  assert.equal(config.worker.concurrency, 12);
  assert.equal(config.worker.lockDurationMs, 45000);
  assert.equal(config.worker.heartbeatIntervalMs, 10000);
  assert.equal(config.worker.shutdownTimeoutMs, 20000);
});
