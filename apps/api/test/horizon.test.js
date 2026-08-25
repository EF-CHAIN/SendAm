const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  attachHorizonResilience,
  HorizonOutageError,
  HorizonWriteUncertainError,
  isHorizonWriteUncertain,
} = require('../src/config/horizon');

// A minimal axios-shaped client so we can exercise the real interceptor logic
// without a network or the Stellar SDK. `hostsBehavior` maps an origin to one
// of: 'ok' | 'error' | 'timeout' | 'hang'.
const makeFakeHttpClient = (hostsBehavior, record) => {
  const instance = {
    interceptors: {
      request: {
        use: (onFulfilled) => {
          instance.__onRequest = onFulfilled;
        },
      },
      response: {
        use: (onFulfilled, onRejected) => {
          instance.__onFulfilled = onFulfilled;
          instance.__onRejected = onRejected;
        },
      },
    },
    request: async (config) => {
      if (instance.__onRequest) config = instance.__onRequest(config);
      const method = (config.method || 'get').toLowerCase();
      const host = new URL(config.url).origin;
      const behavior = hostsBehavior[host] || 'ok';
      record.push({ method, host, url: config.url, data: config.data, timeout: config.timeout, retrying: !!config.__horizonRetrying });
      let response;
      let error;
      if (behavior === 'ok') {
        response = { data: { ok: true, hash: 'H' }, status: 200, config };
      } else if (behavior === 'error') {
        error = new Error('boom');
        error.response = { status: 500, config };
        error.config = config;
      } else if (behavior === 'timeout') {
        error = new Error('timeout');
        error.code = 'ECONNABORTED';
        error.response = undefined;
        error.config = config;
      } else if (behavior === 'hang') {
        return new Promise(() => {});
      }
      if (error) {
        if (instance.__onRejected) return instance.__onRejected(error);
        throw error;
      }
      if (instance.__onFulfilled) return instance.__onFulfilled(response);
      return response;
    },
  };
  return instance;
};

const H1 = 'https://h1.test';
const H2 = 'https://h2.test';
const H3 = 'https://h3.test';

test('reads fail over to the next approved endpoint on timeout', async () => {
  const record = [];
  const client = makeFakeHttpClient({ [H1]: 'timeout', [H2]: 'ok' }, record);
  attachHorizonResilience(client, { baseUrls: [H1, H2], timeoutMs: 50 });

  const res = await client.request({ method: 'get', url: `${H1}/accounts/GABC` });
  assert.equal(res.data.ok, true);

  const h2Call = record.find((r) => r.host === H2);
  assert.ok(h2Call, 'request should have failed over to h2');
  // The failover request to h2 must target h2's origin exactly.
  assert.equal(new URL(h2Call.url).origin, H2);
});

test('every request carries the bounded timeout', async () => {
  const record = [];
  const client = makeFakeHttpClient({ [H1]: 'timeout', [H2]: 'ok' }, record);
  attachHorizonResilience(client, { baseUrls: [H1, H2], timeoutMs: 50 });

  await client.request({ method: 'get', url: `${H1}/accounts/GABC` });
  for (const entry of record) {
    assert.equal(entry.timeout, 50, 'per-request timeout must be applied');
  }
});

test('writes go to a single endpoint and are never resubmitted (no duplicate)', async () => {
  const record = [];
  const client = makeFakeHttpClient({ [H1]: 'ok', [H2]: 'ok' }, record);
  attachHorizonResilience(client, { baseUrls: [H1, H2], timeoutMs: 50 });

  const res = await client.request({ method: 'post', url: `${H1}/transactions`, data: { xdr: 'SIGNED' } });
  assert.equal(res.data.ok, true);

  const posts = record.filter((r) => r.method === 'post');
  assert.equal(posts.length, 1, 'a write must be issued exactly once');
  assert.equal(posts[0].host, H1);
  assert.equal(posts.filter((r) => r.host === H2).length, 0, 'a write must never fail over to another endpoint');
});

test('an ambiguous write failure surfaces as uncertain and does not hit other endpoints', async () => {
  const record = [];
  const client = makeFakeHttpClient({ [H1]: 'timeout', [H2]: 'ok' }, record);
  attachHorizonResilience(client, { baseUrls: [H1, H2], timeoutMs: 50 });

  await assert.rejects(
    () => client.request({ method: 'post', url: `${H1}/transactions`, data: { xdr: 'SIGNED' } }),
    (err) => {
      assert.ok(isHorizonWriteUncertain(err), 'should be a HorizonWriteUncertainError');
      const posts = record.filter((r) => r.method === 'post');
      assert.equal(posts.length, 1, 'write must not be retried/resubmitted');
      assert.equal(posts.filter((r) => r.host === H2).length, 0);
      return true;
    },
  );
});

test('a definitive (HTTP) write error is surfaced as-is, still no failover', async () => {
  const record = [];
  const client = makeFakeHttpClient({ [H1]: 'error', [H2]: 'ok' }, record);
  attachHorizonResilience(client, { baseUrls: [H1, H2], timeoutMs: 50 });

  await assert.rejects(
    () => client.request({ method: 'post', url: `${H1}/transactions`, data: { xdr: 'SIGNED' } }),
    (err) => {
      assert.equal(err.response?.status, 500);
      assert.equal(record.filter((r) => r.method === 'post' && r.host === H2).length, 0);
      return true;
    },
  );
});

test('failover preserves the request body (network passphrase baked into the signed tx is untouched)', async () => {
  const record = [];
  const client = makeFakeHttpClient({ [H1]: 'ok' }, record);
  attachHorizonResilience(client, { baseUrls: [H1], timeoutMs: 50 });

  const signedTx = { xdr: 'SIGNED-XDR', networkPassphrase: 'Test SDF Network ; September 2015' };
  await client.request({ method: 'post', url: `${H1}/transactions`, data: signedTx });

  const post = record.find((r) => r.method === 'post');
  assert.equal(post.data, signedTx, 'the signed payload must pass through unchanged');
});

test('circuit breaker opens an endpoint after threshold failures and recovers after cooldown', async () => {
  let clock = 1000;
  const now = () => clock;

  const record = [];
  const client = makeFakeHttpClient({ [H1]: 'timeout', [H2]: 'ok' }, record);
  const { getHealth } = attachHorizonResilience(client, {
    baseUrls: [H1, H2],
    timeoutMs: 50,
    circuit: { threshold: 1, cooldownMs: 30000 },
    now,
  });

  // h1 fails and opens.
  await client.request({ method: 'get', url: `${H1}/accounts/GABC` });
  assert.equal(getHealth().find((h) => h.url === H1).open, true);

  // While open, h1 is skipped and only h2 is used.
  record.length = 0;
  await client.request({ method: 'get', url: `${H1}/accounts/GABC` });
  assert.equal(record.filter((r) => r.host === H1).length, 0, 'open endpoint must be skipped');
  assert.ok(record.find((r) => r.host === H2));

  // After the cooldown, h1 is tried again (recovery).
  clock += 60000;
  record.length = 0;
  await client.request({ method: 'get', url: `${H1}/accounts/GABC` });
  assert.ok(record.find((r) => r.host === H1), 'endpoint should recover after cooldown');
});

test('total outage: once every endpoint is circuit-open, requests fail fast with an outage error', async () => {
  const record = [];
  const client = makeFakeHttpClient({ [H1]: 'timeout', [H2]: 'timeout' }, record);
  attachHorizonResilience(client, {
    baseUrls: [H1, H2],
    timeoutMs: 50,
    circuit: { threshold: 1, cooldownMs: 30000 },
  });

  // First attempt exhausts and opens both endpoints.
  await assert.rejects(() => client.request({ method: 'get', url: `${H1}/accounts/GABC` }));
  // Subsequent attempt short-circuits to a total outage.
  await assert.rejects(
    () => client.request({ method: 'get', url: `${H1}/accounts/GABC` }),
    (err) => err instanceof HorizonOutageError,
  );
});

test('three endpoints: reads fail over in order and stop at the first success', async () => {
  const record = [];
  const client = makeFakeHttpClient({ [H1]: 'timeout', [H2]: 'timeout', [H3]: 'ok' }, record);
  attachHorizonResilience(client, { baseUrls: [H1, H2, H3], timeoutMs: 50, circuit: { threshold: 5, cooldownMs: 1000 } });

  const res = await client.request({ method: 'get', url: `${H1}/accounts/GABC` });
  assert.equal(res.data.ok, true);
  assert.ok(record.find((r) => r.host === H3));
  assert.equal(record.filter((r) => r.host === H3).length, 1, 'must not keep probing after a success');
});
