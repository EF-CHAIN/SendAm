const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

const calls = { createChallenge: [], verifyChallenge: [], revokeSession: [] };
const audits = [];
let createChallengeImpl;
let verifyChallengeImpl;
let revokeSessionImpl;
let writeAuditLogImpl;

inject('services/restAuth.service', {
  createChallenge: async (account) => { calls.createChallenge.push(account); return createChallengeImpl(account); },
  verifyChallenge: async (transaction) => { calls.verifyChallenge.push(transaction); return verifyChallengeImpl(transaction); },
  revokeSession: async (id) => { calls.revokeSession.push(id); return revokeSessionImpl(id); },
});
inject('common/audit.service', { writeAuditLog: async (entry) => writeAuditLogImpl(entry) });

const { challenge, token, logout } = require('../src/controllers/auth.controller');

const ACCOUNT = `G${'A'.repeat(55)}`;

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

beforeEach(() => {
  calls.createChallenge.length = 0;
  calls.verifyChallenge.length = 0;
  calls.revokeSession.length = 0;
  audits.length = 0;
  createChallengeImpl = async (account) => {
    if (!account) throw new Error('A valid Stellar account is required');
    return { transaction: 'challenge-xdr', networkPassphrase: 'Test SDF Network ; September 2015' };
  };
  verifyChallengeImpl = async (transaction) => {
    if (!transaction) throw new Error('Challenge transaction is required');
    return { token: 'session-token', expiresAt: '2030-01-01T00:00:00.000Z', account: ACCOUNT, user: { id: 'user-1' } };
  };
  revokeSessionImpl = async () => {};
  writeAuditLogImpl = async (entry) => { audits.push(entry); };
});

test('challenge returns the created challenge and audits it against the account', async () => {
  const req = { query: { account: ACCOUNT } };
  const res = response();
  await challenge(req, res);

  assert.deepEqual(calls.createChallenge, [ACCOUNT]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.message, 'Challenge created');
  assert.deepEqual(res.body.data, { transaction: 'challenge-xdr', networkPassphrase: 'Test SDF Network ; September 2015' });
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0], { actorType: 'stellar_account', actorId: ACCOUNT, action: 'auth.challenge.created', req });
});

test('challenge rejects a missing account with a 400 validation envelope and a failure audit', async () => {
  const req = { query: {} };
  const res = response();
  await challenge(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.message, 'A valid Stellar account is required');
  assert.equal(res.body.error.code, 'validation_error');
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0], {
    actorType: 'anonymous',
    action: 'auth.challenge.failed',
    metadata: { reason: 'A valid Stellar account is required' },
    req,
  });
});

test('challenge maps a downstream service failure to a 400 without leaking a success audit', async () => {
  createChallengeImpl = async () => { throw new Error('Challenge store unavailable'); };
  const res = response();
  await challenge({ query: { account: ACCOUNT } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.message, 'Challenge store unavailable');
  assert.deepEqual(audits.map((entry) => entry.action), ['auth.challenge.failed']);
});

test('challenge reports a failing success audit as a failed challenge', async () => {
  writeAuditLogImpl = async (entry) => {
    audits.push(entry);
    if (entry.action === 'auth.challenge.created') throw new Error('audit write failed');
  };
  const res = response();
  await challenge({ query: { account: ACCOUNT } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, 'audit write failed');
  assert.deepEqual(audits.map((entry) => entry.action), ['auth.challenge.created', 'auth.challenge.failed']);
});

test('token exchanges a signed challenge for a bearer session and audits the user', async () => {
  const req = { body: { transaction: 'signed-xdr' } };
  const res = response();
  await token(req, res);

  assert.deepEqual(calls.verifyChallenge, ['signed-xdr']);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.message, 'Authenticated');
  assert.deepEqual(res.body.data, { token: 'session-token', expiresAt: '2030-01-01T00:00:00.000Z', tokenType: 'Bearer' });
  assert.deepEqual(audits, [{
    actorType: 'user',
    actorId: 'user-1',
    action: 'auth.session.created',
    metadata: { account: ACCOUNT },
    req,
  }]);
});

test('token rejects a missing transaction with a 401 and a verification-failed audit', async () => {
  const req = { body: {} };
  const res = response();
  await token(req, res);

  assert.deepEqual(calls.verifyChallenge, [undefined]);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.success, false);
  assert.equal(res.body.message, 'Challenge transaction is required');
  assert.equal(res.body.error.code, 'unauthorized');
  assert.deepEqual(audits, [{
    actorType: 'anonymous',
    action: 'auth.verification.failed',
    metadata: { reason: 'Challenge transaction is required' },
    req,
  }]);
});

test('token maps a downstream verification failure to a 401 and never returns a token', async () => {
  verifyChallengeImpl = async () => { throw new Error('Challenge signature is invalid'); };
  const res = response();
  await token({ body: { transaction: 'tampered-xdr' } }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.message, 'Challenge signature is invalid');
  assert.equal(res.body.data, undefined);
  assert.deepEqual(audits.map((entry) => entry.action), ['auth.verification.failed']);
});

test('logout revokes the current session and audits the user', async () => {
  const req = { restSession: { id: 'session-1' }, restUser: { id: 'user-1' } };
  const res = response();
  await logout(req, res, () => assert.fail('must not call next on success'));

  assert.deepEqual(calls.revokeSession, ['session-1']);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.message, 'Session revoked');
  assert.equal(res.body.data, null);
  assert.deepEqual(audits, [{ actorType: 'user', actorId: 'user-1', action: 'auth.session.revoked', req }]);
});

test('logout forwards a missing session context to the error handler without responding', async () => {
  const res = response();
  let forwarded;
  await logout({}, res, (error) => { forwarded = error; });

  assert.ok(forwarded instanceof TypeError);
  assert.equal(res.body, null);
  assert.equal(calls.revokeSession.length, 0);
  assert.equal(audits.length, 0);
});

test('logout forwards a downstream revoke failure to the error handler without auditing', async () => {
  const failure = new Error('session store unavailable');
  revokeSessionImpl = async () => { throw failure; };
  const res = response();
  let forwarded;
  await logout({ restSession: { id: 'session-1' }, restUser: { id: 'user-1' } }, res, (error) => { forwarded = error; });

  assert.equal(forwarded, failure);
  assert.equal(res.body, null);
  assert.equal(audits.length, 0);
});
