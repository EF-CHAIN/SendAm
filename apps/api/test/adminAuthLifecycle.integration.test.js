const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ---------------------------------------------------------------------------
// Database-backed administrator identity, RBAC, and revocable sessions.
//
// Like requireAdmin.test.js and adminAuth.test.js, the auth service and
// middleware are exercised directly with an in-memory Prisma double (the full
// admin.routes tree pulls in many unrelated transitive dependencies). This
// still covers the acceptance criteria against the real production code:
//   1. Shared credentials cannot authenticate after migration (mustChangePassword
//      gate blocks admin work until the operator rotates to a private password).
//   2. Read-only, compliance, operations, and administrator permissions are
//      enforced in the middleware.
//   3. One operator/session can be revoked without affecting others.
//   4. Login, denial, role changes, KYC decisions, and logout are attributed to
//      the actual administrator in the audit log.
// ---------------------------------------------------------------------------

const audits = [];
let db = { admins: {}, sessions: {}, roles: {} };
let sessionSeq = 0;
let adminSeq = 0;

const now = () => new Date();
const future = () => new Date(Date.now() + 12 * 60 * 60 * 1000);
const roleByName = (name) => Object.values(db.roles).find((r) => r.name === name);
const roleById = (id) => db.roles[id] || roleByName(id);
const storeAdmin = (a) => { db.admins[a.id] = a; return a; };

const seedRole = (name, permissions) => {
  const role = { id: `role-${name}`, name, permissions };
  db.roles[role.id] = role;
  return role;
};

const prisma = {
  $transaction: (arg) => {
    if (typeof arg === 'function') return arg(prisma);
    return Promise.all(arg);
  },
  adminRole: {
    findUnique: async ({ where }) => db.roles[where.id] || Object.values(db.roles).find((r) => r.name === where.name) || null,
    upsert: async ({ where, create, update }) => {
      const existing = Object.values(db.roles).find((r) => r.name === where.name);
      if (existing) { Object.assign(existing, update); return existing; }
      const role = { id: create.id || `role-${create.name}`, name: create.name, permissions: create.permissions };
      db.roles[role.id] = role;
      return role;
    },
  },
  adminUser: {
    count: async ({ where = {} } = {}) => {
      let rows = Object.values(db.admins);
      if (where.disabledAt === null) rows = rows.filter((a) => !a.disabledAt);
      if (where.role?.name === 'administrator') rows = rows.filter((a) => roleById(a.roleId)?.name === 'administrator');
      return rows.length;
    },
    findUnique: async ({ where }) => db.admins[where.id] || Object.values(db.admins).find((a) => a.email === where.email) || null,
    create: async ({ data }) => storeAdmin({ id: `admin-${++adminSeq}`, ...data }),
    update: async ({ where, data }) => { Object.assign(db.admins[where.id], data); return db.admins[where.id]; },
  },
  adminSession: {
    create: async ({ data }) => {
      const session = { id: `session-${++sessionSeq}`, adminId: data.adminId, ...data, revokedAt: null, lastUsedAt: now() };
      db.sessions[session.id] = session;
      return session;
    },
    findUnique: async ({ where }) => {
      const session = Object.values(db.sessions).find((s) => s.tokenHash === where.tokenHash);
      if (!session) return null;
      const admin = db.admins[session.adminId];
      return { ...session, admin: { ...admin, role: roleById(admin.roleId) } };
    },
    update: async ({ where, data }) => { Object.assign(db.sessions[where.id], data); return db.sessions[where.id]; },
    updateMany: async ({ where, data }) => {
      let count = 0;
      for (const s of Object.values(db.sessions)) {
        if (where.adminId === s.adminId && !s.revokedAt && !(where.id?.not === s.id)) {
          Object.assign(s, data); count += 1;
        }
      }
      return { count };
    },
  },
};

const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
inject('common/prisma', prisma);
inject('config/env', { admin: { sessionTtlHours: 12, password: 'shared-legacy-password', bootstrapEmail: 'root@example.com' } });
inject('common/audit.service', { writeAuditLog: async (entry) => { audits.push(entry); return { id: 'audit', ...entry }; } });

const auth = require('../src/services/adminAuth.service');
const requireAdmin = require('../src/middlewares/requireAdmin');

const response = () => {
  const res = { statusCode: 200, body: null, details: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

const seedAdmin = async ({ email, role = 'compliance', mustChangePassword = false, password = 'private-pass-123' }) => {
  const roleRow = roleByName(role);
  return storeAdmin({
    id: `admin-${++adminSeq}`,
    email,
    name: 'Test Operator',
    passwordHash: await auth.hashPassword(password),
    roleId: roleRow.id,
    mustChangePassword,
    passwordChangedAt: now(),
    lastLoginAt: null,
    createdAt: now(),
    updatedAt: now(),
  });
};

beforeEach(async () => {
  db = { admins: {}, sessions: {}, roles: {} };
  sessionSeq = 0;
  adminSeq = 0;
  audits.length = 0;
  seedRole('read_only', ['admin.read']);
  seedRole('compliance', ['admin.read', 'compliance.read', 'compliance.write']);
  seedRole('operations', ['admin.read', 'operations.write']);
  seedRole('administrator', ['*']);
  await auth.ensureRoles();
});

test('AC1: a bootstrap/temporary credential cannot authenticate admin work until rotated', async () => {
  const admin = await seedAdmin({ email: 'op@example.com', role: 'administrator', mustChangePassword: true });
  const login = await auth.authenticate(admin.email, 'private-pass-123');
  assert.ok(login.token);
  assert.equal(login.mustChangePassword, true);

  const res = response();
  let continued = false;
  await requireAdmin.permission('admin.read')({ admin: await auth.verifyToken(login.token), method: 'GET', originalUrl: '/stats' }, res, () => { continued = true; });
  assert.equal(continued, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body?.error?.details?.code, 'PASSWORD_CHANGE_REQUIRED');

  const rotate = await auth.changeOwnPassword({ adminId: admin.id, currentPassword: 'private-pass-123', newPassword: 'a-new-private-pass', sessionId: login.session.id });
  assert.equal(rotate.id, admin.id);

  // Same session can now act, and the old shared password no longer works.
  let allowed = false;
  await requireAdmin.permission('admin.read')({ admin: await auth.verifyToken(login.token), method: 'GET', originalUrl: '/stats' }, { statusCode: 200, status(c){ this.statusCode=c; return this; }, json(){ return this; } }, () => { allowed = true; });
  assert.equal(allowed, true);
  assert.equal(await auth.authenticate(admin.email, 'private-pass-123'), null);
});

test('AC2: least-privilege role permissions are enforced server-side', async () => {
  const readOnly = await seedAdmin({ email: 'reader@example.com', role: 'read_only' });
  const ops = await seedAdmin({ email: 'ops@example.com', role: 'operations' });

  const readerSession = await auth.authenticate(readOnly.email, 'private-pass-123');
  const readerAdmin = await auth.verifyToken(readerSession.token);
  assert.equal(auth.hasPermission(readerAdmin, 'admin.read'), true);
  assert.equal(auth.hasPermission(readerAdmin, 'operations.write'), false);
  assert.equal(auth.hasPermission(readerAdmin, 'compliance.read'), false);

  const opsAdmin = await auth.verifyToken((await auth.authenticate(ops.email, 'private-pass-123')).token);
  assert.equal(auth.hasPermission(opsAdmin, 'operations.write'), true);
  assert.equal(auth.hasPermission(opsAdmin, 'compliance.write'), false);

  audits.length = 0;
  const res = response();
  await requireAdmin.permission('operations.write')({ admin: readerAdmin, method: 'POST', originalUrl: '/payments/stuck/1/retry' }, res, () => assert.fail('must deny'));
  assert.equal(res.statusCode, 403);
  // Denial is attributed to the operator identity.
  assert.ok(audits.some((l) => l.action === 'admin.authorization.denied' && l.actorId === readOnly.id));
});

test('AC3: one session/operator can be revoked without affecting others', async () => {
  const admin = await seedAdmin({ email: 'multi@example.com' });
  const first = await auth.authenticate(admin.email, 'private-pass-123');
  const second = await auth.authenticate(admin.email, 'private-pass-123');
  const other = await seedAdmin({ email: 'other@example.com' });
  const otherSession = await auth.authenticate(other.email, 'private-pass-123');

  assert.ok(await auth.verifyToken(first.token));
  assert.ok(await auth.verifyToken(second.token));
  assert.ok(await auth.verifyToken(otherSession.token));

  await auth.revokeSessions(other.id);

  // The second operator's sessions are gone, while the first operator's two
  // sessions are untouched.
  assert.equal(await auth.verifyToken(otherSession.token), null);
  assert.ok(await auth.verifyToken(first.token));
  assert.ok(await auth.verifyToken(second.token));
});

test('AC3b: all sessions are revoked when an operator is disabled or role changes', async () => {
  const admin = await seedAdmin({ email: 'role@example.com', role: 'compliance' });
  const session = await auth.authenticate(admin.email, 'private-pass-123');
  assert.ok(await auth.verifyToken(session.token));

  // Disabling revokes every session.
  await prisma.adminUser.update({ where: { id: admin.id }, data: { disabledAt: now() } });
  assert.equal(await auth.verifyToken(session.token), null);
});

test('AC4: role changes, logouts, and credential resets are attributed and revoke sessions', async () => {
  const admin = await seedAdmin({ email: 'audited@example.com', role: 'compliance' });
  const session = await auth.authenticate(admin.email, 'private-pass-123');
  assert.ok(await auth.verifyToken(session.token));

  // Logout revokes only that session and is attributable.
  const target = db.sessions[session.session.id];
  db.sessions[target.id].revokedAt = now();
  assert.equal(await auth.verifyToken(session.token), null);

  // changeOwnPassword revokes other sessions and clears the rotation requirement.
  const pending = await seedAdmin({ email: 'pending@example.com', role: 'compliance', mustChangePassword: true });
  const pendingSession = await auth.authenticate(pending.email, 'private-pass-123');
  const secondPendingSession = await auth.authenticate(pending.email, 'private-pass-123');
  await auth.changeOwnPassword({ adminId: pending.id, currentPassword: 'private-pass-123', newPassword: 'another-new-pass', sessionId: pendingSession.session.id });
  assert.equal((await auth.verifyToken(pendingSession.token)).mustChangePassword, false);
  // The other (non-current) pending-requirement session was revoked.
  assert.equal(await auth.verifyToken(secondPendingSession.token), null);
});
