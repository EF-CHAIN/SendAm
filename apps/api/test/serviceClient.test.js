const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createServiceClient } = require('../src/services/serviceClient');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test('degrades gracefully when unconfigured, without making a network call', async () => {
  let called = false;
  const client = createServiceClient({
    name: 'ai',
    baseUrl: undefined,
    secret: undefined,
    fetchImpl: async () => {
      called = true;
      return jsonResponse(200, {});
    },
    logger: silentLogger,
  });

  assert.equal(client.enabled, false);
  const result = await client.post('/decode', { text: 'hi' });
  assert.deepEqual(result, { ok: false, reason: 'ai service not configured' });
  assert.equal(called, false);
});

test('a URL without a secret still counts as unconfigured (HMAC is mandatory)', async () => {
  const client = createServiceClient({
    name: 'ai',
    baseUrl: 'http://ai.internal',
    secret: undefined,
    logger: silentLogger,
  });
  assert.equal(client.enabled, false);
});

test('signs the exact request body with HMAC-SHA256 and a unix-seconds timestamp', async () => {
  let seen;
  const client = createServiceClient({
    name: 'ai',
    baseUrl: 'http://ai.internal/',
    secret: 'shared-secret',
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return jsonResponse(200, { intent: 'UNKNOWN' });
    },
    logger: silentLogger,
  });

  const before = Math.floor(Date.now() / 1000);
  const result = await client.post('/decode', { text: 'send 5k to @ada' }, { idempotencyKey: 'k-1' });
  const after = Math.floor(Date.now() / 1000);

  assert.deepEqual(result, { ok: true, data: { intent: 'UNKNOWN' } });
  assert.equal(seen.url, 'http://ai.internal/decode'); // trailing slash trimmed
  assert.equal(seen.options.method, 'POST');

  const raw = seen.options.body;
  const expectedSignature = crypto.createHmac('sha256', 'shared-secret').update(raw).digest('hex');
  assert.equal(seen.options.headers['X-Sendam-Signature'], expectedSignature);

  const timestamp = Number(seen.options.headers['X-Sendam-Timestamp']);
  assert.ok(timestamp >= before && timestamp <= after, 'timestamp is current unix seconds');
  assert.equal(seen.options.headers['Idempotency-Key'], 'k-1');
  assert.equal(seen.options.headers['Content-Type'], 'application/json');
  assert.ok(seen.options.signal instanceof AbortSignal, 'timeout signal attached');
});

test('GET requests sign the empty body and carry no Content-Type', async () => {
  let seen;
  const client = createServiceClient({
    name: 'ns',
    baseUrl: 'http://ns.internal',
    secret: 's',
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return jsonResponse(200, { found: true });
    },
    logger: silentLogger,
  });

  await client.get('/federation?q=ada*sendam.app&type=name');
  const expectedSignature = crypto.createHmac('sha256', 's').update('').digest('hex');
  assert.equal(seen.options.headers['X-Sendam-Signature'], expectedSignature);
  assert.equal(seen.options.headers['Content-Type'], undefined);
  assert.equal(seen.options.body, undefined);
});

test('non-2xx responses become {ok:false} with status, never a throw', async () => {
  const client = createServiceClient({
    name: 'settlement',
    baseUrl: 'http://settlement.internal',
    secret: 's',
    fetchImpl: async () => jsonResponse(409, { code: 'INSUFFICIENT_FUNDS', message: 'nope' }),
    logger: silentLogger,
  });

  const result = await client.post('/transfer', {});
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.data.code, 'INSUFFICIENT_FUNDS');
});

test('network failures become {ok:false, reason: unreachable}, never a throw', async () => {
  const client = createServiceClient({
    name: 'ai',
    baseUrl: 'http://ai.internal',
    secret: 's',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
    logger: silentLogger,
  });

  const result = await client.post('/decode', { text: 'x' });
  assert.deepEqual(result, { ok: false, reason: 'ai service unreachable' });
});
