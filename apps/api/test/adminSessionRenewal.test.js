const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const sessions = new Map();
let nextId = 0;
const prisma = {
  $transaction: async (callback) => callback(prisma),
  adminSession: {
    findUnique: async ({ where }) => sessions.get(where.id) || null,
    updateMany: async ({ where, data }) => {
      const session = sessions.get(where.id);
      if (!session
        || session.adminId !== where.adminId
        || session.revokedAt
        || session.expiresAt <= where.expiresAt.gt) {
        return { count: 0 };
      }
      Object.assign(session, data);
      return { count: 1 };
    },
    create: async ({ data }) => {
      const session = { id: `session-${++nextId}`, ...data, revokedAt: null };
      sessions.set(session.id, session);
      return session;
    },
  },
};

const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
inject('common/prisma', prisma);
inject('config/env', { admin: { sessionTtlHours: 12 } });
const auth = require('../src/services/adminAuth.service');

const seedSession = (overrides = {}) => {
  const session = {
    id: `session-${++nextId}`,
    adminId: 'admin-1',
    tokenHash: 'existing-token-hash',
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    ...overrides,
  };
  sessions.set(session.id, session);
  return session;
};

beforeEach(() => {
  sessions.clear();
  nextId = 0;
});

test('renewal revokes the current session and creates a fresh hashed-token session', async () => {
  const current = seedSession();
  const result = await auth.renewSession({ adminId: current.adminId, sessionId: current.id });

  assert.ok(result.token);
  assert.notEqual(result.token, current.tokenHash);
  assert.ok(current.revokedAt instanceof Date);
  assert.equal(result.session.adminId, current.adminId);
  assert.notEqual(result.session.id, current.id);
  assert.notEqual(result.session.tokenHash, result.token);
  assert.ok(result.session.expiresAt > current.expiresAt);
});

test('renewal rejects a session belonging to a different administrator without changing it', async () => {
  const current = seedSession();
  await assert.rejects(
    auth.renewSession({ adminId: 'another-admin', sessionId: current.id }),
    (error) => error.statusCode === 401,
  );
  assert.equal(current.revokedAt, null);
  assert.equal(sessions.size, 1);
});

test('renewal rejects expired sessions without creating a replacement', async () => {
  const current = seedSession({ expiresAt: new Date(Date.now() - 1) });
  await assert.rejects(
    auth.renewSession({ adminId: current.adminId, sessionId: current.id }),
    (error) => error.statusCode === 401,
  );
  assert.equal(current.revokedAt, null);
  assert.equal(sessions.size, 1);
});

test('renewal rejects revoked sessions without creating a replacement', async () => {
  const current = seedSession({ revokedAt: new Date() });
  await assert.rejects(
    auth.renewSession({ adminId: current.adminId, sessionId: current.id }),
    (error) => error.statusCode === 401,
  );
  assert.equal(sessions.size, 1);
});
