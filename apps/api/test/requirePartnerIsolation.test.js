const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

const logs = { warn: [], error: [] };
inject('utils/logger', {
  warn: (...args) => { logs.warn.push(args); },
  error: (...args) => { logs.error.push(args); },
  info: () => {},
  debug: () => {},
});

const {
  requirePartnerIsolation,
  preventCrossPartnerAdminModification,
} = require('../src/middlewares/requirePartnerIsolation');

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

// Request carrying a mocked prisma.adminUser lookup, mirroring app.locals.prisma.
const adminRequest = ({ actor, targetId, target, lookupError } = {}) => {
  const lookups = [];
  const req = {
    user: actor,
    params: targetId === undefined ? {} : { id: targetId },
    app: {
      locals: {
        prisma: {
          adminUser: {
            findUnique: async (query) => {
              lookups.push(query);
              if (lookupError) throw lookupError;
              return target;
            },
          },
        },
      },
    },
  };
  return { req, lookups };
};

const run = async (middleware, req) => {
  const res = response();
  let nextCalls = 0;
  await middleware(req, res, () => { nextCalls += 1; });
  return { res, nextCalls };
};

beforeEach(() => {
  logs.warn.length = 0;
  logs.error.length = 0;
});

test('requirePartnerIsolation rejects a request with no admin context as 401', async () => {
  const req = {};
  const { res, nextCalls } = await run(requirePartnerIsolation(), req);

  assert.equal(nextCalls, 0);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { success: false, message: 'Unauthorized' });
  assert.equal(req.partnerContext, undefined);
  assert.equal(req.enforcePartnerScope, undefined);
});

test('requirePartnerIsolation scopes a partner admin to their partner and continues', async () => {
  const req = { user: { id: 'admin-1', partnerId: 'partner-a' } };
  const { res, nextCalls } = await run(requirePartnerIsolation('Transaction'), req);

  assert.equal(nextCalls, 1);
  assert.equal(res.body, null);
  assert.deepEqual(req.partnerContext, { partnerId: 'partner-a', requiresPartnerIsolation: true });
  assert.equal(typeof req.enforcePartnerScope, 'function');
});

test('requirePartnerIsolation treats a null partnerId as the unscoped primary tenant', async () => {
  const req = { user: { id: 'admin-root', partnerId: null } };
  const { nextCalls } = await run(requirePartnerIsolation(), req);

  assert.equal(nextCalls, 1);
  assert.deepEqual(req.partnerContext, { partnerId: null, requiresPartnerIsolation: false });
  const where = { status: 'ACTIVE' };
  assert.equal(req.enforcePartnerScope(where), where);
  assert.deepEqual(req.enforcePartnerScope(), {});
});

test('enforcePartnerScope passes the where clause through for every supported entity type', async () => {
  for (const entityType of [undefined, 'User', 'Transaction', 'SupportCase', 'Unknown']) {
    const req = { user: { id: 'admin-1', partnerId: 'partner-a' } };
    await run(requirePartnerIsolation(entityType), req);
    const where = { id: 'record-1' };
    assert.equal(req.enforcePartnerScope(where), where, `entity type ${entityType}`);
    assert.deepEqual(req.enforcePartnerScope(), {}, `entity type ${entityType}`);
  }
});

test('requirePartnerIsolation returns a generic 500 and logs when context setup throws', async () => {
  const req = {};
  Object.defineProperty(req, 'user', { get() { throw new Error('session decode failed'); } });
  const { res, nextCalls } = await run(requirePartnerIsolation(), req);

  assert.equal(nextCalls, 0);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { success: false, message: 'Internal server error' });
  assert.deepEqual(logs.error, [['Error in partner isolation middleware', 'session decode failed']]);
});

test('preventCrossPartnerAdminModification allows a partner admin to modify an admin of the same partner', async () => {
  const { req, lookups } = adminRequest({
    actor: { id: 'admin-1', partnerId: 'partner-a' },
    targetId: 'admin-2',
    target: { id: 'admin-2', partnerId: 'partner-a' },
  });
  const { res, nextCalls } = await run(preventCrossPartnerAdminModification, req);

  assert.equal(nextCalls, 1);
  assert.equal(res.body, null);
  assert.deepEqual(lookups, [{ where: { id: 'admin-2' } }]);
  assert.equal(logs.warn.length, 0);
});

test('preventCrossPartnerAdminModification denies cross-partner modification with the exact 403 shape', async () => {
  const { req } = adminRequest({
    actor: { id: 'admin-1', partnerId: 'partner-a' },
    targetId: 'admin-9',
    target: { id: 'admin-9', partnerId: 'partner-b' },
  });
  const { res, nextCalls } = await run(preventCrossPartnerAdminModification, req);

  assert.equal(nextCalls, 0);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, {
    success: false,
    message: 'You cannot modify administrators from other partners',
  });
  assert.deepEqual(logs.warn, [['Admin admin-1 attempted to modify admin admin-9 from different partner']]);
});

test('preventCrossPartnerAdminModification denies a partner admin modifying a primary-tenant admin', async () => {
  const { req } = adminRequest({
    actor: { id: 'admin-1', partnerId: 'partner-a' },
    targetId: 'admin-root',
    target: { id: 'admin-root', partnerId: null },
  });
  const { res, nextCalls } = await run(preventCrossPartnerAdminModification, req);

  assert.equal(nextCalls, 0);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.success, false);
});

test('preventCrossPartnerAdminModification lets a primary-tenant admin act on any admin without a lookup', async () => {
  const { req, lookups } = adminRequest({ actor: { id: 'admin-root', partnerId: null }, targetId: 'admin-9' });
  const { nextCalls } = await run(preventCrossPartnerAdminModification, req);

  assert.equal(nextCalls, 1);
  assert.equal(lookups.length, 0);
});

test('preventCrossPartnerAdminModification defers to other guards when actor or target id is missing', async () => {
  for (const scenario of [
    { targetId: 'admin-2' },
    { actor: { id: 'admin-1', partnerId: 'partner-a' } },
  ]) {
    const { req, lookups } = adminRequest(scenario);
    const { res, nextCalls } = await run(preventCrossPartnerAdminModification, req);
    assert.equal(nextCalls, 1);
    assert.equal(res.body, null);
    assert.equal(lookups.length, 0);
  }
});

test('preventCrossPartnerAdminModification returns 404 when the target admin does not exist', async () => {
  const { req } = adminRequest({
    actor: { id: 'admin-1', partnerId: 'partner-a' },
    targetId: 'missing',
    target: null,
  });
  const { res, nextCalls } = await run(preventCrossPartnerAdminModification, req);

  assert.equal(nextCalls, 0);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { success: false, message: 'Admin not found' });
});

test('preventCrossPartnerAdminModification returns a generic 500 and logs when the lookup fails', async () => {
  const { req } = adminRequest({
    actor: { id: 'admin-1', partnerId: 'partner-a' },
    targetId: 'admin-2',
    lookupError: new Error('connection refused'),
  });
  const { res, nextCalls } = await run(preventCrossPartnerAdminModification, req);

  assert.equal(nextCalls, 0);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { success: false, message: 'Internal server error' });
  assert.deepEqual(logs.error, [['Error in cross-partner admin check', 'connection refused']]);
});
