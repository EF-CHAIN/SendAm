'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const matches = (row, where) => {
  if (!where || Object.keys(where).length === 0) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return cond.some((sub) => matches(row, sub));
    if (key === 'AND') return cond.every((sub) => matches(row, sub));
    const value = row[key];
    if (cond === null) return value == null;
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      return Object.entries(cond).every(([op, operand]) => {
        const eq = (a, b) => ((a instanceof Date || b instanceof Date)
          ? new Date(a).getTime() === new Date(b).getTime()
          : a === b);
        switch (op) {
          case 'equals': return eq(value, operand);
          case 'gt': return new Date(value) > new Date(operand);
          case 'lt': return new Date(value) < new Date(operand);
          case 'gte': return new Date(value) >= new Date(operand);
          case 'in': return operand.includes(value);
          case 'notIn': return !operand.includes(value);
          default: return false;
        }
      });
    }
    return value === cond;
  });
};

const createCollection = (initial = []) => {
  let seq = 0;
  const rows = [...initial];
  return {
    _rows: rows,
    _clear: () => { rows.length = 0; },
    create: async ({ data }) => {
      const record = { id: data.id || `id-${++seq}`, ...data };
      rows.push(record);
      return { ...record };
    },
    findUnique: async ({ where }) => rows.find((r) => matches(r, where)) || null,
    findFirst: async ({ where } = {}) => rows.find((r) => matches(r, where)) || null,
    findMany: async ({ where = {} } = {}) => rows.filter((r) => matches(r, where)),
    count: async ({ where = {} } = {}) => rows.filter((r) => matches(r, where)).length,
    update: async ({ where, data }) => {
      const r = rows.find((x) => matches(x, where));
      if (!r) { const e = new Error('Record not found'); e.code = 'P2025'; throw e; }
      Object.assign(r, data);
      return { ...r };
    },
    updateMany: async ({ where = {}, data }) => {
      const hits = rows.filter((r) => matches(r, where));
      hits.forEach((r) => Object.assign(r, data));
      return { count: hits.length };
    },
    deleteMany: async ({ where = {} } = {}) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) if (matches(rows[i], where)) rows.splice(i, 1);
      return { count: before - rows.length };
    },
  };
};

const buildPrisma = () => {
  const p = {
    user: createCollection(),
    wallet: createCollection(),
    transaction: createCollection(),
    kycProfile: createCollection(),
    voiceCommand: createCollection(),
    contact: createCollection(),
    alias: createCollection(),
    notification: createCollection(),
    quote: createCollection(),
    restSession: createCollection(),
    legalHold: createCollection(),
    auditLog: createCollection(),
    auditChainHead: createCollection(),
    userErasure: createCollection(),
  };
  p.$transaction = async (fn) => fn(p);
  return p;
};

const mockPrisma = buildPrisma();
const auditLogs = [];
mockPrisma.auditLog.create = async (args) => {
  const record = { id: `audit-${auditLogs.length}`, ...args.data };
  auditLogs.push(record);
  return record;
};

const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

inject('../src/common/prisma', mockPrisma);

const legalHoldService = require('../src/compliance/legalHold');
const { anonymizeUser } = require('../src/services/userErasure.service');
const { runRetentionSweep } = require('../src/jobs/retention.jobs');

beforeEach(() => {
  auditLogs.length = 0;
  Object.values(mockPrisma).forEach((c) => {
    if (typeof c === 'object' && c && typeof c._clear === 'function') c._clear();
  });
});

test('isUnderLegalHold detects legal hold flag directly on User model', async () => {
  await mockPrisma.user.create({ data: { id: 'u-flagged', phoneNumber: '+2348000000001', legalHold: true } });
  await mockPrisma.user.create({ data: { id: 'u-normal', phoneNumber: '+2348000000002', legalHold: false } });

  const flagged = await legalHoldService.isUnderLegalHold('u-flagged', { db: mockPrisma });
  const normal = await legalHoldService.isUnderLegalHold('u-normal', { db: mockPrisma });

  assert.equal(flagged, true);
  assert.equal(normal, false);
});

test('isUnderLegalHold detects active LegalHold table records and respects release/expiry', async () => {
  await mockPrisma.user.create({ data: { id: 'u-hold', phoneNumber: '+2348000000003', legalHold: false } });
  await mockPrisma.legalHold.create({
    data: {
      userId: 'u-hold',
      reason: 'Subpoena regarding transactions',
      heldBy: 'compliance-officer-1',
      releasedAt: null,
      expiresAt: null,
    },
  });

  const active = await legalHoldService.isUnderLegalHold('u-hold', { db: mockPrisma });
  assert.equal(active, true);

  // Expired hold is not active
  await mockPrisma.legalHold.updateMany({
    where: { userId: 'u-hold' },
    data: { expiresAt: new Date(Date.now() - 10000) },
  });
  const expired = await legalHoldService.isUnderLegalHold('u-hold', { db: mockPrisma });
  assert.equal(expired, false);

  // Released hold is not active
  await mockPrisma.legalHold.updateMany({
    where: { userId: 'u-hold' },
    data: { expiresAt: null, releasedAt: new Date() },
  });
  const released = await legalHoldService.isUnderLegalHold('u-hold', { db: mockPrisma });
  assert.equal(released, false);
});

test('getProtectedUserIds aggregates user flags and active hold records', async () => {
  await mockPrisma.user.create({ data: { id: 'u1', legalHold: true } });
  await mockPrisma.user.create({ data: { id: 'u2', legalHold: false } });
  await mockPrisma.legalHold.create({ data: { userId: 'u2', reason: 'Court order', heldBy: 'admin', releasedAt: null } });

  const protectedIds = await legalHoldService.getProtectedUserIds({ db: mockPrisma });
  assert.ok(protectedIds.includes('u1'));
  assert.ok(protectedIds.includes('u2'));
});

test('assertNoLegalHold blocks erasure and records attempt in audit log', async () => {
  await mockPrisma.user.create({ data: { id: 'u-subpoena', legalHold: true } });

  await assert.rejects(
    async () => {
      await legalHoldService.assertNoLegalHold('u-subpoena', {
        operation: 'erasure',
        actorType: 'customer',
        actorId: 'u-subpoena',
        db: mockPrisma,
      });
    },
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'LEGAL_HOLD_ACTIVE');
      assert.match(err.message, /forbidden for user under legal hold/);
      return true;
    }
  );

  const blockedAudit = auditLogs.find((l) => l.action === 'compliance.legal_hold.attempt_blocked');
  assert.ok(blockedAudit, 'audit log should record the blocked attempt');
  assert.equal(blockedAudit.entityId, 'u-subpoena');
  assert.equal(blockedAudit.metadata.operation, 'erasure');
});

test('setLegalHold updates User model, creates LegalHold record, and audits action', async () => {
  await mockPrisma.user.create({ data: { id: 'u-target', legalHold: false } });

  const hold = await legalHoldService.setLegalHold({
    userId: 'u-target',
    reason: 'SEC formal inquiry request',
    heldBy: 'compliance-admin',
    db: mockPrisma,
  });

  assert.ok(hold.id);
  const updatedUser = await mockPrisma.user.findUnique({ where: { id: 'u-target' } });
  assert.equal(updatedUser.legalHold, true);

  const setAudit = auditLogs.find((l) => l.action === 'admin.legal_hold.set');
  assert.ok(setAudit);
  assert.equal(setAudit.metadata.userId, 'u-target');
});

test('releaseLegalHold releases table records, clears User flag, and audits action', async () => {
  await mockPrisma.user.create({ data: { id: 'u-release', legalHold: true } });
  await mockPrisma.legalHold.create({ data: { userId: 'u-release', reason: 'Investigation', heldBy: 'admin', releasedAt: null } });

  await legalHoldService.releaseLegalHold({
    userId: 'u-release',
    releasedBy: 'compliance-officer',
    db: mockPrisma,
  });

  const updatedUser = await mockPrisma.user.findUnique({ where: { id: 'u-release' } });
  assert.equal(updatedUser.legalHold, false);

  const activeHolds = await mockPrisma.legalHold.findMany({ where: { userId: 'u-release', releasedAt: null } });
  assert.equal(activeHolds.length, 0);

  const releaseAudit = auditLogs.find((l) => l.action === 'admin.legal_hold.released');
  assert.ok(releaseAudit);
});

test('anonymizeUser explicitly rejects when user is marked with legalHold', async () => {
  await mockPrisma.user.create({
    data: {
      id: 'u-held-erasure',
      phoneNumber: '+2348000000099',
      whatsappName: 'Held User',
      legalHold: true,
    },
  });

  await assert.rejects(
    async () => {
      await anonymizeUser(mockPrisma, {
        userId: 'u-held-erasure',
        actorId: 'u-held-erasure',
        actorType: 'customer',
      });
    },
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'LEGAL_HOLD_ACTIVE');
      return true;
    }
  );

  // User was not modified
  const user = await mockPrisma.user.findUnique({ where: { id: 'u-held-erasure' } });
  assert.equal(user.phoneNumber, '+2348000000099');
  assert.equal(user.anonymizedAt, undefined);
});

test('automated TTL retention jobs exclude records of users under legalHold', async () => {
  const oldDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000); // 1 year ago

  // User 1 is on legal hold
  await mockPrisma.user.create({ data: { id: 'u-held-purge', legalHold: true } });
  await mockPrisma.notification.create({
    data: { id: 'notif-held', userId: 'u-held-purge', recipient: '+2348001', body: 'Sensitive notice', createdAt: oldDate, status: 'delivered' },
  });

  // User 2 is not on legal hold
  await mockPrisma.user.create({ data: { id: 'u-free-purge', legalHold: false } });
  await mockPrisma.notification.create({
    data: { id: 'notif-free', userId: 'u-free-purge', recipient: '+2348002', body: 'Regular notice', createdAt: oldDate, status: 'delivered' },
  });

  const sweep = await runRetentionSweep({
    db: mockPrisma,
    models: ['Notification'],
    now: new Date(),
  });

  // The free user's notification should be redacted/purged
  const freeNotif = await mockPrisma.notification.findUnique({ where: { id: 'notif-free' } });
  assert.equal(freeNotif.body, '[purged]');

  // The held user's notification must NOT be purged
  const heldNotif = await mockPrisma.notification.findUnique({ where: { id: 'notif-held' } });
  assert.equal(heldNotif.body, 'Sensitive notice');
});
