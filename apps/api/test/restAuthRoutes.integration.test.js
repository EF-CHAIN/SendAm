const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
const counters = new Map();
const consumedKeys = [];
let revokedSession;
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
inject('services/restAuth.service', {
  createChallenge: async () => ({ transaction: 'challenge-xdr', networkPassphrase: 'testnet' }),
  verifyChallenge: async (transaction) => {
    if (transaction === 'invalid') throw new Error('Invalid signed challenge');
    return { token: 'session-token', expiresAt: new Date(Date.now() + 60000), user: { id: 'user-1' }, account: 'GACCOUNT' };
  },
  findSession: async (token) => token === 'valid-session-token-that-is-long-enough'
    ? { id: 'session-1', user: { id: 'user-1' } } : null,
  revokeSession: async (id) => { revokedSession = id; },
});
// Audit persistence is intentionally unavailable; authentication must continue
// because writeAuditLog's public contract degrades to null on storage failure.
inject('common/audit.service', { writeAuditLog: async () => null });

const authRoutes = require('../src/routes/auth.routes');
const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  return app;
};
const withServer = async (run) => {
  const server = http.createServer(buildApp());
  await new Promise((resolve) => server.listen(0, resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
};

beforeEach(() => { counters.clear(); consumedKeys.length = 0; revokedSession = null; });

test('challenge and token endpoints work over HTTP even when audit storage is unavailable', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/auth/challenge?account=GACCOUNT`)).status, 200);
    assert.equal((await fetch(`${base}/api/auth/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transaction: 'signed' }),
    })).status, 200);
    assert.equal((await fetch(`${base}/api/auth/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transaction: 'invalid' }),
    })).status, 401);
  });
});

test('logout requires a session and revokes the authenticated session over HTTP', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/auth/logout`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${base}/api/auth/logout`, {
      method: 'POST', headers: { authorization: 'Bearer valid-session-token-that-is-long-enough' },
    })).status, 200);
  });
  assert.equal(revokedSession, 'session-1');
});

test('auth attempts use the shared auth-prefixed store and return 429 after ten requests', async () => {
  await withServer(async (base) => {
    for (let index = 0; index < 10; index += 1) {
      assert.equal((await fetch(`${base}/api/auth/challenge?account=GACCOUNT`)).status, 200);
    }
    assert.equal((await fetch(`${base}/api/auth/challenge?account=GACCOUNT`)).status, 429);
  });
  assert.ok(consumedKeys.length >= 11);
  assert.ok(consumedKeys.every((key) => key.startsWith('auth:')));
});
