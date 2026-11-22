const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.HEALTH_CHECK_TIMEOUT_MS = '100';
process.env.HORIZON_URLS = 'https://horizon-primary.example.test/';
const { CURRENT_VERSION, setKmsProvider } = require('../src/services/crypto.service');

const inject = (path, exports) => {
  const filename = require.resolve(path);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

const prisma = { $queryRaw: async () => [{ '?column?': 1 }] };
const redis = { pingRedis: async () => 'PONG' };
inject('../src/common/prisma', prisma);
inject('../src/queues/queue.service', redis);

const fetch = globalThis.fetch;

test('deep health reports each dependency and returns 503 without leaking errors', async (t) => {
  const query = t.mock.method(prisma, '$queryRaw');
  const ping = t.mock.method(redis, 'pingRedis');
  const horizon = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  const kms = {
    generateDataKey: async () => ({ plaintextKey: Buffer.alloc(32), encryptedDataKey: 'key-reference' }),
    decryptDataKey: async () => Buffer.alloc(32),
  };
  const generateDataKey = t.mock.method(kms, 'generateDataKey');
  setKmsProvider(kms);

  const healthRoutes = require('../src/routes/health.routes');
  const app = express();
  app.use(healthRoutes);
  const server = await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/health/deep`;
  const healthy = await fetch(url);
  assert.equal(healthy.status, 200);
  assert.equal(healthy.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await healthy.json(), {
    status: 'ok',
    components: { postgres: 'healthy', redis: 'healthy', stellar_horizon: 'healthy', kms: 'healthy' },
  });
  assert.deepEqual([...query.mock.calls[0].arguments[0]], ['SELECT 1']);
  assert.equal(ping.mock.callCount(), 1);
  assert.equal(horizon.mock.calls[0].arguments[0], 'https://horizon-primary.example.test/');
  assert.deepEqual(generateDataKey.mock.calls[0].arguments, [{ keyVersion: CURRENT_VERSION }]);

  horizon.mock.mockImplementation(async () => new Response(null, { status: 502 }));
  generateDataKey.mock.mockImplementation(async () => { throw new Error('private KMS provider details'); });
  const degraded = await fetch(url);
  assert.equal(degraded.status, 503);
  assert.deepEqual(await degraded.json(), {
    status: 'degraded',
    components: { postgres: 'healthy', redis: 'healthy', stellar_horizon: 'unhealthy', kms: 'unhealthy' },
  });

  horizon.mock.mockImplementation(async () => new Response(null, { status: 200 }));
  generateDataKey.mock.mockImplementation(() => new Promise(() => {}));
  query.mock.mockImplementation(async () => { throw new Error('private PostgreSQL provider details'); });
  ping.mock.mockImplementation(async () => { throw new Error('private Redis provider details'); });
  const timedOut = await fetch(url, { signal: AbortSignal.timeout(2_000) });
  assert.equal(timedOut.status, 503);
  assert.deepEqual(await timedOut.json(), {
    status: 'degraded',
    components: { postgres: 'unhealthy', redis: 'unhealthy', stellar_horizon: 'healthy', kms: 'unhealthy' },
  });
});
