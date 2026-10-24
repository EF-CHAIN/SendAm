const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

// Mock rate-limit store: counts hits per prefixed key in memory, or fails on
// demand, so the middleware's decisions can be driven without PostgreSQL.
const stores = [];
const hits = new Map();
let storeFailure = null;
class MockRateStore {
  constructor(prefix = '') {
    this.prefix = prefix;
    this.incrementedKeys = [];
    stores.push(this);
  }

  init(options) { this.windowMs = options.windowMs; }

  async increment(key) {
    if (storeFailure) throw storeFailure;
    const fullKey = `${this.prefix}${key}`;
    this.incrementedKeys.push(fullKey);
    const totalHits = (hits.get(fullKey) || 0) + 1;
    hits.set(fullKey, totalHits);
    return { totalHits, resetTime: new Date(Date.now() + 30000) };
  }

  async decrement() {}

  async resetKey() {}
}
inject('middlewares/postgresRateStore', MockRateStore);

const metricCalls = [];
inject('observability/metrics', { increment: (name, labels) => { metricCalls.push({ name, labels }); } });

const createAccountRateLimit = require('../src/middlewares/accountRateLimit');
const { AppError } = require('../src/errors');

const WINDOW_MS = 60000;
const MAX = 2;

const buildApp = ({ user, routerLevel = false } = {}) => {
  const limiter = createAccountRateLimit({ windowMs: WINDOW_MS, max: MAX, prefix: 'test:' });
  const errors = [];
  const router = express.Router();
  if (routerLevel) router.use(limiter);
  router.post('/send', ...(routerLevel ? [] : [limiter]), (_req, res) => res.status(200).json({ ok: true }));

  const app = express();
  app.use((req, _res, next) => {
    if (user) req.restUser = user;
    next();
  });
  app.use('/api/wallet', router);
  app.use((error, _req, res, _next) => {
    errors.push(error);
    res.status(error.statusCode || 500).json({ error: error.code || error.message });
  });
  return { app, errors };
};

const withServer = async (app, run) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}/api/wallet/send`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
};

beforeEach(() => {
  stores.length = 0;
  hits.clear();
  metricCalls.length = 0;
  storeFailure = null;
});

test('each limiter gets its own store bound to the prefix and window', () => {
  buildApp();
  assert.equal(stores.length, 1);
  assert.equal(stores[0].prefix, 'test:');
  assert.equal(stores[0].windowMs, WINDOW_MS);
});

test('requests under the limit are allowed with standard RateLimit headers and no legacy headers', async () => {
  const { app, errors } = buildApp({ user: { id: 'user-1' } });
  await withServer(app, async (url) => {
    const first = await fetch(url, { method: 'POST' });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true });
    assert.equal(first.headers.get('ratelimit-policy'), `${MAX};w=60`);
    assert.equal(first.headers.get('ratelimit-limit'), String(MAX));
    assert.equal(first.headers.get('ratelimit-remaining'), '1');
    assert.equal(first.headers.get('ratelimit-reset'), '30');
    assert.equal(first.headers.get('x-ratelimit-limit'), null);
    assert.equal(first.headers.get('retry-after'), null);

    const second = await fetch(url, { method: 'POST' });
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('ratelimit-remaining'), '0');
  });
  assert.equal(errors.length, 0);
  assert.equal(metricCalls.length, 0);
});

test('an authenticated request is keyed by account id rather than IP', async () => {
  const { app } = buildApp({ user: { id: 'user-1' } });
  await withServer(app, async (url) => {
    await fetch(url, { method: 'POST' });
  });
  assert.deepEqual(stores[0].incrementedKeys, ['test:account:user-1']);
});

test('an unauthenticated request falls back to an IP key', async () => {
  const { app } = buildApp();
  await withServer(app, async (url) => {
    await fetch(url, { method: 'POST' });
  });
  assert.equal(stores[0].incrementedKeys.length, 1);
  assert.match(stores[0].incrementedKeys[0], /^test:ip:(::ffff:)?127\.0\.0\.1$/);
});

test('exceeding the limit forwards a rate_limited AppError that renders as 429 with Retry-After', async () => {
  const { app, errors } = buildApp({ user: { id: 'user-1' } });
  await withServer(app, async (url) => {
    for (let i = 0; i < MAX; i += 1) {
      assert.equal((await fetch(url, { method: 'POST' })).status, 200);
    }
    const throttled = await fetch(url, { method: 'POST' });
    assert.equal(throttled.status, 429);
    assert.deepEqual(await throttled.json(), { error: 'rate_limited' });
    assert.equal(throttled.headers.get('retry-after'), '30');
    assert.equal(throttled.headers.get('ratelimit-policy'), `${MAX};w=60`);
    assert.equal(throttled.headers.get('ratelimit-limit'), String(MAX));
    assert.equal(throttled.headers.get('ratelimit-remaining'), '0');
    assert.equal(throttled.headers.get('ratelimit-reset'), '30');
  });

  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof AppError);
  assert.equal(errors[0].code, 'rate_limited');
  assert.equal(errors[0].statusCode, 429);
});

test('a throttled account records the abuse metric labeled with account scope and full route', async () => {
  const { app } = buildApp({ user: { id: 'user-1' } });
  await withServer(app, async (url) => {
    for (let i = 0; i <= MAX; i += 1) await fetch(url, { method: 'POST' });
  });
  assert.deepEqual(metricCalls, [{
    name: 'sendam_rate_limit_exceeded_total',
    labels: { scope: 'account', route: '/api/wallet/send' },
  }]);
});

test('a throttled anonymous caller records the abuse metric with ip scope', async () => {
  const { app } = buildApp();
  await withServer(app, async (url) => {
    for (let i = 0; i <= MAX; i += 1) await fetch(url, { method: 'POST' });
  });
  assert.deepEqual(metricCalls, [{
    name: 'sendam_rate_limit_exceeded_total',
    labels: { scope: 'ip', route: '/api/wallet/send' },
  }]);
});

test('a router-level limiter labels the metric with the request path when no route has matched yet', async () => {
  const { app } = buildApp({ user: { id: 'user-1' }, routerLevel: true });
  await withServer(app, async (url) => {
    for (let i = 0; i <= MAX; i += 1) await fetch(url, { method: 'POST' });
  });
  assert.deepEqual(metricCalls, [{
    name: 'sendam_rate_limit_exceeded_total',
    labels: { scope: 'account', route: '/api/wallet/send' },
  }]);
});

test('separate accounts are throttled independently', async () => {
  const user = { id: 'user-1' };
  const { app } = buildApp({ user });
  await withServer(app, async (url) => {
    for (let i = 0; i < MAX; i += 1) await fetch(url, { method: 'POST' });
    assert.equal((await fetch(url, { method: 'POST' })).status, 429);
    user.id = 'user-2';
    assert.equal((await fetch(url, { method: 'POST' })).status, 200);
  });
});

test('a store failure fails closed: the error reaches the error handler and the route never runs', async () => {
  storeFailure = new Error('rate store unavailable');
  const { app, errors } = buildApp({ user: { id: 'user-1' } });
  await withServer(app, async (url) => {
    const res = await fetch(url, { method: 'POST' });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'rate store unavailable' });
    assert.equal(res.headers.get('ratelimit-limit'), null);
    assert.equal(res.headers.get('retry-after'), null);
  });
  assert.deepEqual(errors, [storeFailure]);
  assert.equal(metricCalls.length, 0);
});
