const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

process.env.ENABLE_WALLET_REST_API = 'true';

const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

const counters = new Map();
const consumedKeys = [];
inject('services/rateLimit.service', {
  consume: async (key) => {
    consumedKeys.push(key);
    const totalHits = (counters.get(key) || 0) + 1;
    counters.set(key, totalHits);
    return { totalHits, resetTime: new Date(Date.now() + 60000) };
  },
  decrement: async () => {},
  resetKey: async () => {},
});

let sessionUser = { id: 'user-1', phoneNumber: '+10000000001' };
inject('services/restAuth.service', {
  findSession: async (token) => (token === 'valid-token' ? { id: 'session-1', user: sessionUser } : null),
});
inject('controllers/wallet.controller', {
  createWallet: (req, res) => res.status(201).json({ ok: true }),
  checkBalance: (req, res) => res.status(200).json({ ok: true }),
  getTransactionHistory: (req, res) => res.status(200).json({ ok: true }),
  getStatement: (req, res) => res.status(200).json({ ok: true }),
  sendFunds: (req, res) => res.status(200).json({ ok: true }),
});

const metrics = require('../src/observability/metrics');
const walletRoutes = require('../src/routes/wallet.routes');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/wallet', walletRoutes);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.code || error.message }));
  return app;
};
const withServer = async (run) => {
  const server = http.createServer(buildApp());
  await new Promise((resolve) => server.listen(0, resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
};

beforeEach(() => {
  counters.clear();
  consumedKeys.length = 0;
  metrics.resetMetrics();
  sessionUser = { id: 'user-1', phoneNumber: '+10000000001' };
});

test('wallet routes are keyed by account, not just IP', async () => {
  await withServer(async (base) => {
    await fetch(`${base}/api/wallet/balance`, { headers: { authorization: 'Bearer valid-token' } });
    assert.ok(consumedKeys.some((key) => key.startsWith('wallet:account:user-1')));
  });
});

test('send is rate limited far tighter than general wallet reads', async () => {
  await withServer(async (base) => {
    const body = JSON.stringify({ amount: '1', destination: 'G'.repeat(56) });
    const headers = { authorization: 'Bearer valid-token', 'content-type': 'application/json' };
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`${base}/api/wallet/send`, { method: 'POST', headers, body });
      assert.equal(res.status, 200);
    }
    const res = await fetch(`${base}/api/wallet/send`, { method: 'POST', headers, body });
    assert.equal(res.status, 429);
    const rateLimitedBody = await res.json();
    assert.equal(rateLimitedBody.error, 'rate_limited');
  });
});

test('tripping the send limit records an abuse metric labeled by scope and route', async () => {
  await withServer(async (base) => {
    const body = JSON.stringify({ amount: '1', destination: 'G'.repeat(56) });
    const headers = { authorization: 'Bearer valid-token', 'content-type': 'application/json' };
    for (let i = 0; i < 6; i += 1) {
      await fetch(`${base}/api/wallet/send`, { method: 'POST', headers, body });
    }
    const rendered = metrics.renderMetrics();
    assert.match(rendered, /sendam_rate_limit_exceeded_total\{scope="account",route="\/api\/wallet\/send"\} 1/);
  });
});

test('two accounts sharing an IP get independent send limits', async () => {
  await withServer(async (base) => {
    const body = JSON.stringify({ amount: '1', destination: 'G'.repeat(56) });
    const headers = { authorization: 'Bearer valid-token', 'content-type': 'application/json' };
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await fetch(`${base}/api/wallet/send`, { method: 'POST', headers, body })).status, 200);
    }
    assert.equal((await fetch(`${base}/api/wallet/send`, { method: 'POST', headers, body })).status, 429);

    sessionUser = { id: 'user-2', phoneNumber: '+10000000002' };
    assert.equal((await fetch(`${base}/api/wallet/send`, { method: 'POST', headers, body })).status, 200);
  });
});
