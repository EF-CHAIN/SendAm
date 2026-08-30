const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

const owner = { id: 'owner-1', phoneNumber: '+2348000000001', kycTier: 0 };
const calls = {};
const config = { features: { walletRestApi: true } };
inject('config/env', config);
inject('middlewares/requireAdmin', () => (_req, res) => res.sendStatus(401));
inject('services/restAuth.service', {
  findSession: async (token) => token === 'valid-session-token-that-is-long-enough'
    ? { id: 'session-1', user: owner } : null,
});
inject('wallet/wallet.service', {
  ensureWalletsForUser: async ({ user }) => { calls.create = user; return []; },
  balancesForUser: async (args) => { calls.balance = args; return [{ asset: 'XLM', value: '1' }]; },
  transactionHistory: async (args) => { calls.history = args; return []; },
});
inject('wallet/stellar.adapter', { validateAddress: () => true });
inject('payment/payment.orchestrator', {
  executePayment: async (args) => {
    calls.send = args;
    return { transaction: { _id: 'tx-1', status: 'success', rail: 'stellar' }, receipt: {} };
  },
});
inject('compliance/compliance.service', {
  getOrCreateKycProfile: async (user) => { calls.profile = user; return { id: 'kyc-1' }; },
  startKycVerification: async (args) => { calls.kycStart = args; return { id: 'kyc-1', status: 'pending' }; },
  processSmileIdCallback: async (body) => {
    calls.callback = body;
    if (body.signature !== 'valid') {
      const error = new Error('Invalid or expired Smile ID callback signature');
      error.statusCode = 401;
      throw error;
    }
    return { duplicate: false };
  },
});
inject('compliance/pin.service', { hashPin: (pin) => `hashed:${pin}` });
inject('common/prisma', {
  user: { update: async (args) => { calls.pin = args; return owner; } },
});

const walletRoutes = require('../src/routes/wallet.routes');
const complianceRoutes = require('../src/compliance/compliance.routes');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/wallet', walletRoutes);
  app.use('/api/compliance', complianceRoutes);
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  return app;
};
const withServer = async (run) => {
  const server = http.createServer(buildApp());
  await new Promise((resolve) => server.listen(0, resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
};
const request = (base, pathName, { method = 'GET', token, body } = {}) => fetch(`${base}${pathName}`, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

beforeEach(() => {
  for (const key of Object.keys(calls)) delete calls[key];
  config.features.walletRestApi = true;
});

test('every customer wallet, PIN, and KYC route rejects missing, expired, and revoked sessions', async () => {
  const operations = [
    ['/api/wallet/create', { method: 'POST', body: {} }],
    ['/api/wallet/balance', {}],
    ['/api/wallet/transactions', {}],
    ['/api/wallet/send', { method: 'POST', body: { amount: '1', destination: 'GDEST' } }],
    ['/api/wallet/%2B2348999999999/balance', {}],
    ['/api/wallet/%2B2348999999999/transactions', {}],
    ['/api/compliance/pin', { method: 'POST', body: { pin: '1234' } }],
    ['/api/compliance/kyc', {}],
    ['/api/compliance/kyc/start', { method: 'POST', body: {} }],
  ];
  await withServer(async (base) => {
    for (const token of [undefined, 'expired-session-token-that-is-long-enough', 'revoked-session-token-that-is-long-enough']) {
      for (const [pathName, options] of operations) {
        assert.equal((await request(base, pathName, { ...options, token })).status, 401, `${pathName} must reject ${token || 'missing'} session`);
      }
    }
  });
});

test('all customer operations use only the authenticated owner despite caller phone values', async () => {
  const token = 'valid-session-token-that-is-long-enough';
  const attackerPhone = '+2348999999999';
  await withServer(async (base) => {
    assert.equal((await request(base, '/api/wallet/create', { method: 'POST', token, body: { phoneNumber: attackerPhone } })).status, 201);
    assert.equal((await request(base, `/api/wallet/${encodeURIComponent(attackerPhone)}/balance`, { token })).status, 200);
    assert.equal((await request(base, `/api/wallet/${encodeURIComponent(attackerPhone)}/transactions`, { token })).status, 200);
    assert.equal((await request(base, '/api/wallet/send', { method: 'POST', token, body: { phoneNumber: attackerPhone, amount: '1', destination: 'GDEST' } })).status, 200);
    assert.equal((await request(base, '/api/compliance/pin', { method: 'POST', token, body: { phoneNumber: attackerPhone, pin: '1234' } })).status, 200);
    assert.equal((await request(base, '/api/compliance/kyc', { token })).status, 200);
    assert.equal((await request(base, '/api/compliance/kyc/start', { method: 'POST', token, body: { phoneNumber: attackerPhone, country: 'NG' } })).status, 202);
  });
  assert.equal(calls.create, owner);
  assert.deepEqual(calls.balance, { phoneNumber: owner.phoneNumber });
  assert.deepEqual(calls.history, { userId: owner.id });
  assert.equal(calls.send.sender, owner);
  assert.equal(calls.pin.where.id, owner.id);
  assert.equal(calls.profile, owner);
  assert.equal(calls.kycStart.user, owner);
});

test('Smile ID callback route reaches verification and rejects an invalid signature', async () => {
  await withServer(async (base) => {
    const valid = await request(base, '/api/compliance/kyc/callback/smileid', {
      method: 'POST', body: { signature: 'valid', ResultCode: '1020' },
    });
    assert.equal(valid.status, 200);
    assert.equal(calls.callback.ResultCode, '1020');
    const invalid = await request(base, '/api/compliance/kyc/callback/smileid', {
      method: 'POST', body: { signature: 'invalid' },
    });
    assert.equal(invalid.status, 401);
  });
});

test('REST kill switch blocks wallet, PIN, and KYC operations even with a valid session', async () => {
  config.features.walletRestApi = false;
  const token = 'valid-session-token-that-is-long-enough';
  await withServer(async (base) => {
    assert.equal((await request(base, '/api/wallet/balance', { token })).status, 404);
    assert.equal((await request(base, '/api/compliance/pin', { method: 'POST', token, body: { pin: '1234' } })).status, 404);
    assert.equal((await request(base, '/api/compliance/kyc', { token })).status, 404);
  });
});
