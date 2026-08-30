const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const audits = [];
const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
inject('services/adminAuth.service', {
  verifyToken: async (token) => token === 'valid-session-token-that-is-long-enough' ? { id: 'admin-1', permissions: ['compliance.write'] } : null,
  hasPermission: (admin, permission) => admin.permissions.includes(permission),
});
inject('common/audit.service', { writeAuditLog: async (entry) => { audits.push(entry); } });
const requireAdmin = require('../src/middlewares/requireAdmin');

const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('authentication rejects missing and revoked-looking sessions', async () => {
  const res = response(); await requireAdmin.authenticate({ headers: {} }, res, () => assert.fail('must not continue'));
  assert.equal(res.statusCode, 401);
});

test('permission denial is forbidden and audit-visible with the operator identity', async () => {
  audits.length = 0; const res = response();
  await requireAdmin.permission('operations.write')({ admin: { id: 'admin-1', permissions: ['compliance.write'] }, method: 'POST', originalUrl: '/sensitive' }, res, () => assert.fail('must not continue'));
  assert.equal(res.statusCode, 403); assert.equal(audits[0].actorId, 'admin-1'); assert.equal(audits[0].action, 'admin.authorization.denied');
});

test('an explicitly granted permission continues', async () => {
  let continued = false;
  await requireAdmin.permission('compliance.write')({ admin: { id: 'admin-1', permissions: ['compliance.write'] } }, response(), () => { continued = true; });
  assert.equal(continued, true);
});
