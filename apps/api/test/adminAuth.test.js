const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

let storedSession; let disabled = false; let revoked = false;
const admin = { id: 'admin-1', email: 'operator@example.com', name: 'Operator', disabledAt: null, role: { name: 'compliance', permissions: ['admin.read', 'compliance.write'] } };
const prisma = {
  adminUser: {
    findUnique: async ({ where }) => where.email === admin.email ? { ...admin, disabledAt: disabled ? new Date() : null } : null,
    update: async () => admin,
  },
  adminSession: {
    create: async ({ data }) => { storedSession = { id: 'session-1', ...data, revokedAt: null, admin }; return storedSession; },
    findUnique: async ({ where }) => storedSession?.tokenHash === where.tokenHash ? { ...storedSession, revokedAt: revoked ? new Date() : null, admin: { ...admin, disabledAt: disabled ? new Date() : null } } : null,
    update: async () => null,
    updateMany: async () => { revoked = true; return { count: 1 }; },
  },
};
const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
inject('common/prisma', prisma);
inject('config/env', { admin: { sessionTtlHours: 12 } });
const auth = require('../src/services/adminAuth.service');

beforeEach(() => { storedSession = null; disabled = false; revoked = false; });

test('password hashes are salted and verify without storing plaintext', async () => {
  const first = await auth.hashPassword('correct horse battery staple');
  const second = await auth.hashPassword('correct horse battery staple');
  assert.notEqual(first, second); assert.equal(await auth.verifyPassword('correct horse battery staple', first), true);
  assert.equal(await auth.verifyPassword('wrong password', first), false);
});

test('login creates an attributable independently revocable session', async () => {
  admin.passwordHash = await auth.hashPassword('correct horse battery staple');
  const result = await auth.authenticate(admin.email, 'correct horse battery staple');
  const identity = await auth.verifyToken(result.token);
  assert.equal(identity.id, admin.id); assert.equal(identity.sessionId, 'session-1'); assert.equal(identity.role, 'compliance');
  await auth.revokeSessions(admin.id); assert.equal(await auth.verifyToken(result.token), null);
});

test('disabled accounts immediately lose access', async () => {
  admin.passwordHash = await auth.hashPassword('correct horse battery staple');
  const result = await auth.authenticate(admin.email, 'correct horse battery staple'); disabled = true;
  assert.equal(await auth.verifyToken(result.token), null);
});

test('least-privilege permission matching does not imply unrelated access', () => {
  assert.equal(auth.hasPermission({ permissions: ['compliance.write'] }, 'compliance.write'), true);
  assert.equal(auth.hasPermission({ permissions: ['compliance.write'] }, 'operations.write'), false);
  assert.equal(auth.hasPermission({ permissions: ['*'] }, 'operations.write'), true);
});
