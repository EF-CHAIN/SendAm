const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Unit coverage for consent.controller.js (#437). The consent service and
// logger are replaced via require.cache before the controller is loaded, so
// these tests exercise only request parsing and response shaping.
const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

const CONSENT_STATUS = { GRANTED: 'granted', DENIED: 'denied', UNSET: 'unset' };
const CONSENT_SOURCES = { CUSTOMER_REQUEST: 'customer_request' };

const calls = { getConsentState: [], setCategoryConsent: [], loggerInfo: [] };
const service = {
  getConsentState: async (args) => {
    calls.getConsentState.push(args);
    return { userId: args.userId, categories: { marketing: 'granted' } };
  },
  setCategoryConsent: async (args) => {
    calls.setCategoryConsent.push(args);
    return args.categories.map((category) => ({ category, status: args.status }));
  },
};

inject('compliance/consent.service', {
  getConsentState: (args) => service.getConsentState(args),
  setCategoryConsent: (args) => service.setCategoryConsent(args),
  CONSENT_STATUS,
  CONSENT_SOURCES,
});
inject('utils/logger', {
  info: (event, fields) => calls.loggerInfo.push({ event, fields }),
  warn: () => {},
  error: () => {},
  debug: () => {},
});

const controller = require('../src/compliance/consent.controller');

const originalService = { ...service };

const makeRes = () => ({
  statusCode: 200,
  body: undefined,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
});

// Runs a handler and resolves with the response plus whatever reached next().
const run = async (handler, req) => {
  const res = makeRes();
  let nextArg;
  let nextCalled = false;
  await handler(req, res, (error) => { nextCalled = true; nextArg = error; });
  return { res, nextCalled, nextArg };
};

const serviceError = (code, message) => Object.assign(new Error(message), { code });

beforeEach(() => {
  Object.assign(service, originalService);
  for (const list of Object.values(calls)) list.length = 0;
});

test('module re-exports CONSENT_STATUS from the consent service', () => {
  assert.equal(controller.CONSENT_STATUS, CONSENT_STATUS);
});

// getOwnPreferences

test('getOwnPreferences returns the authenticated user\'s consent state', async () => {
  const { res, nextCalled } = await run(controller.getOwnPreferences, { user: { id: 'user-1' } });

  assert.deepEqual(calls.getConsentState, [{ userId: 'user-1' }]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { userId: 'user-1', categories: { marketing: 'granted' } });
  assert.equal(nextCalled, false);
});

test('getOwnPreferences forwards service errors to next() without responding', async () => {
  const failure = new Error('database unavailable');
  service.getConsentState = async () => { throw failure; };

  const { res, nextArg } = await run(controller.getOwnPreferences, { user: { id: 'user-1' } });

  assert.equal(nextArg, failure);
  assert.equal(res.body, undefined);
});

// updateOwnPreferences

test('updateOwnPreferences applies the change as a customer request and returns fresh state', async () => {
  const req = { user: { id: 'user-2' }, body: { categories: ['marketing', 'service'], status: 'denied' } };
  const { res, nextCalled } = await run(controller.updateOwnPreferences, req);

  assert.deepEqual(calls.setCategoryConsent, [{
    userId: 'user-2',
    categories: ['marketing', 'service'],
    status: 'denied',
    source: 'customer_request',
    actorType: 'user',
    actorId: 'user-2',
  }]);
  assert.deepEqual(calls.loggerInfo, [{
    event: 'messaging_consent_updated',
    fields: { userId: 'user-2', categories: ['marketing', 'service'], status: 'denied' },
  }]);
  assert.deepEqual(calls.getConsentState, [{ userId: 'user-2' }], 'response is re-read after the write');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { userId: 'user-2', categories: { marketing: 'granted' } });
  assert.equal(nextCalled, false);
});

test('updateOwnPreferences tolerates a missing body and lets the service validate it', async () => {
  service.setCategoryConsent = async (args) => {
    calls.setCategoryConsent.push(args);
    throw serviceError('UNKNOWN_CONSENT_CATEGORY', 'Unknown consent category: undefined');
  };

  const { res } = await run(controller.updateOwnPreferences, { user: { id: 'user-3' } });

  assert.equal(calls.setCategoryConsent[0].categories, undefined);
  assert.equal(calls.setCategoryConsent[0].status, undefined);
  assert.equal(res.statusCode, 400);
});

for (const [code, message] of [
  ['UNKNOWN_CONSENT_CATEGORY', 'Unknown consent category: promos'],
  ['INVALID_CONSENT_STATUS', 'Invalid consent status: maybe'],
  ['REQUIRED_CONSENT_CATEGORY', 'security cannot be switched off'],
]) {
  test(`updateOwnPreferences maps ${code} to a 400 validation response`, async () => {
    service.setCategoryConsent = async () => { throw serviceError(code, message); };

    const req = { user: { id: 'user-4' }, body: { categories: ['promos'], status: 'maybe' } };
    const { res, nextCalled } = await run(controller.updateOwnPreferences, req);

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: message, code });
    assert.equal(nextCalled, false);
    assert.deepEqual(calls.loggerInfo, [], 'rejected changes are not logged as updates');
    assert.deepEqual(calls.getConsentState, [], 'no state is returned for a rejected change');
  });
}

test('updateOwnPreferences forwards unexpected service errors to next()', async () => {
  const failure = serviceError('P1001', 'database unreachable');
  service.setCategoryConsent = async () => { throw failure; };

  const req = { user: { id: 'user-5' }, body: { categories: ['marketing'], status: 'granted' } };
  const { res, nextArg } = await run(controller.updateOwnPreferences, req);

  assert.equal(nextArg, failure);
  assert.equal(res.body, undefined);
  assert.deepEqual(calls.loggerInfo, []);
});

test('updateOwnPreferences forwards errors from re-reading state after the write', async () => {
  const failure = new Error('read replica lagging');
  service.getConsentState = async () => { throw failure; };

  const req = { user: { id: 'user-6' }, body: { categories: ['marketing'], status: 'granted' } };
  const { res, nextArg } = await run(controller.updateOwnPreferences, req);

  assert.equal(calls.setCategoryConsent.length, 1);
  assert.equal(nextArg, failure);
  assert.equal(res.body, undefined);
});

// getCustomerPreferences

test('getCustomerPreferences reads the customer named in the route, not the support agent', async () => {
  const req = { user: { id: 'agent-1' }, params: { userId: 'customer-9' } };
  const { res, nextCalled } = await run(controller.getCustomerPreferences, req);

  assert.deepEqual(calls.getConsentState, [{ userId: 'customer-9' }]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { userId: 'customer-9', categories: { marketing: 'granted' } });
  assert.equal(nextCalled, false);
});

test('getCustomerPreferences forwards service errors to next() without responding', async () => {
  const failure = new Error('database unavailable');
  service.getConsentState = async () => { throw failure; };

  const { res, nextArg } = await run(controller.getCustomerPreferences, { params: { userId: 'customer-9' } });

  assert.equal(nextArg, failure);
  assert.equal(res.body, undefined);
});
