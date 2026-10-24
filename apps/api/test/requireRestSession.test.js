const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

const VALID_TOKEN = 'v'.repeat(48);
const EXPIRED_TOKEN = 'e'.repeat(48);
const user = { id: 'user-1', phoneNumber: '+10000000001' };

// In-memory stand-in for the session store behind restAuth.findSession: it
// resolves active sessions and returns null for unknown or expired ones, the
// same contract the real service exposes.
const sessions = new Map();
const lookups = [];
let lookupFailure = null;
inject('services/restAuth.service', {
  findSession: async (token) => {
    lookups.push(token);
    if (lookupFailure) throw lookupFailure;
    const session = sessions.get(token);
    if (!session || session.expiresAt <= new Date()) return null;
    return session;
  },
});

const requireRestSession = require('../src/middlewares/requireRestSession');

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

const run = async (headers) => {
  const req = { headers };
  const res = response();
  const nextArgs = [];
  await requireRestSession(req, res, (...args) => { nextArgs.push(args); });
  return { req, res, nextArgs };
};

const assertUnauthorized = ({ req, res, nextArgs }) => {
  assert.equal(nextArgs.length, 0);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.success, false);
  assert.equal(res.body.message, 'Unauthorized');
  assert.equal(res.body.error.code, 'unauthorized');
  assert.equal(res.body.error.message, 'Unauthorized');
  assert.equal(req.restSession, undefined);
  assert.equal(req.restUser, undefined);
};

beforeEach(() => {
  sessions.clear();
  lookups.length = 0;
  lookupFailure = null;
  sessions.set(VALID_TOKEN, { id: 'session-1', user, expiresAt: new Date(Date.now() + 3600000) });
  sessions.set(EXPIRED_TOKEN, { id: 'session-2', user, expiresAt: new Date(Date.now() - 1000) });
});

test('a valid bearer session is attached to the request and the chain continues', async () => {
  const { req, res, nextArgs } = await run({ authorization: `Bearer ${VALID_TOKEN}` });

  assert.deepEqual(lookups, [VALID_TOKEN]);
  assert.deepEqual(nextArgs, [[]]);
  assert.equal(res.body, null);
  assert.equal(req.restSession, sessions.get(VALID_TOKEN));
  assert.equal(req.restUser, user);
});

test('an expired session is rejected with a 401 envelope', async () => {
  const result = await run({ authorization: `Bearer ${EXPIRED_TOKEN}` });

  assert.deepEqual(lookups, [EXPIRED_TOKEN]);
  assertUnauthorized(result);
});

test('an unknown or revoked token is rejected with a 401 envelope', async () => {
  const result = await run({ authorization: `Bearer ${'u'.repeat(48)}` });
  assertUnauthorized(result);
});

test('a missing Authorization header is rejected after a null-token lookup', async () => {
  const result = await run({});

  assert.deepEqual(lookups, [null]);
  assertUnauthorized(result);
});

test('malformed Authorization headers never pass a token to the session lookup', async () => {
  for (const authorization of [
    VALID_TOKEN,
    `bearer ${VALID_TOKEN}`,
    `Basic ${VALID_TOKEN}`,
    `Bearer${VALID_TOKEN}`,
    'Bearer',
    '',
  ]) {
    lookups.length = 0;
    const result = await run({ authorization });
    assert.deepEqual(lookups, [null], `header ${JSON.stringify(authorization)}`);
    assertUnauthorized(result);
  }
});

test('an empty bearer token is looked up as-is and rejected', async () => {
  const result = await run({ authorization: 'Bearer ' });

  assert.deepEqual(lookups, ['']);
  assertUnauthorized(result);
});

test('a session-lookup failure is forwarded to the error handler without responding', async () => {
  lookupFailure = new Error('session store unavailable');
  const { req, res, nextArgs } = await run({ authorization: `Bearer ${VALID_TOKEN}` });

  assert.deepEqual(nextArgs, [[lookupFailure]]);
  assert.equal(res.body, null);
  assert.equal(req.restSession, undefined);
  assert.equal(req.restUser, undefined);
});
