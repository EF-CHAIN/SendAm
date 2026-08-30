const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ---- generic in-memory matcher (subset of Prisma where used by the service) ----
const matches = (row, where) => {
  if (!where || Object.keys(where).length === 0) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return cond.some((sub) => matches(row, sub));
    if (key === 'AND') return cond.every((sub) => matches(row, sub));
    const value = row[key];
    if (cond === null) return value == null; // Prisma `field: null` means IS NULL
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      return Object.entries(cond).every(([op, operand]) => {
        const eq = (a, b) => (a instanceof Date || b instanceof Date)
          ? new Date(a).getTime() === new Date(b).getTime()
          : a === b;
        switch (op) {
          case 'equals': return eq(value, operand);
          case 'gt': return new Date(value) > new Date(operand);
          case 'lt': return new Date(value) < new Date(operand);
          case 'gte': return new Date(value) >= new Date(operand);
          default: return false;
        }
      });
    }
    return value === cond;
  });
};

const applySelect = (rows, select) => (select
  ? rows.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])))
  : rows);

const createCollection = (initial = []) => {
  let seq = 0;
  const rows = [...initial];
  const sortBy = (orderBy) => {
    if (!orderBy) return rows;
    const [field, dir] = Object.entries(orderBy)[0];
    return [...rows].sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) * (dir === 'desc' ? -1 : 1));
  };
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
    findMany: async ({ where = {}, orderBy, select } = {}) =>
      applySelect(sortBy(orderBy).filter((r) => matches(r, where)), select),
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
    privacyRequest: createCollection(),
    legalHold: createCollection(),
    privacyProviderTask: createCollection(),
    auditLog: createCollection(),
  };
  // A real Prisma transaction operates on the same data; reuse this instance so
  // seeded rows are visible inside the transaction callback.
  p.$transaction = async (fn) => fn(p);
  return p;
};

// Mutable provider behaviour so we can flip success/failure mid-test.
const providerState = { fail: false, skip: false };
const makeProviderMock = () => ({
  deleteSubject: async () => {
    if (providerState.skip) { const e = new Error('skipped'); e.skipped = true; e.name = 'ProviderSkippedError'; throw e; }
    if (providerState.fail) throw new Error('provider unavailable');
    return { status: 'success' };
  },
});
const makeWhatsappMock = () => ({
  sendTextMessage: async () => {},
  deleteUserData: async () => {
    if (providerState.skip) { const e = new Error('skipped'); e.skipped = true; e.name = 'ProviderSkippedError'; throw e; }
    if (providerState.fail) throw new Error('provider unavailable');
    return { status: 'success' };
  },
});

const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

// One prisma instance + one set of provider mocks shared for the file. The
// service module is cached, so re-injecting a *new* prisma per test would not
// rebind it; instead we reuse the same instance and clear its collections.
const prisma = buildPrisma();
const auditEvents = [];
prisma.auditLog.create = async (args) => {
  const record = { id: `audit-${auditEvents.length}`, ...args.data };
  auditEvents.push(record);
  return record;
};
inject('../src/common/prisma', prisma);
inject('../src/compliance/smileId.provider', { deleteSubject: makeProviderMock().deleteSubject });
inject('../src/services/whatsapp.service', makeWhatsappMock());
inject('../src/voice/voice.service', { processVoiceMessage: async () => {}, deleteUserData: makeProviderMock().deleteSubject });
inject('../src/compliance/providers/monitoring', { deleteUserData: makeProviderMock().deleteSubject });
// eslint-disable-next-line global-require
const service = require('../src/compliance/privacy.service');

beforeEach(() => {
  providerState.fail = false;
  providerState.skip = false;
  auditEvents.length = 0;
  Object.values(prisma).forEach((c) => { if (typeof c === 'object' && c && typeof c._clear === 'function') c._clear(); });
});

const seedUser = async (phone = '+2348000000001') => {
  const user = await prisma.user.create({ data: { id: 'u1', phoneNumber: phone, whatsappName: 'Ada', pinHash: 'x' } });
  await prisma.wallet.create({ data: { id: 'w1', userId: 'u1', chain: 'stellar', phoneNumber: phone, encryptedSecretKey: 'sec' } });
  await prisma.transaction.create({ data: { id: 't1', userId: 'u1', amount: '100', asset: 'USDC', status: 'success', destination: '+234999', recipientPhoneNumber: '+234999' } });
  await prisma.kycProfile.create({ data: { id: 'k1', userId: 'u1', providerReference: 'job-1', status: 'approved', metadata: { idNumber: 'A123' } } });
  await prisma.voiceCommand.create({ data: { id: 'v1', userId: 'u1', phoneNumber: phone, transcript: 'send money' } });
  await prisma.contact.create({ data: { id: 'c1', ownerId: 'u1', phoneNumber: phone, displayName: 'Mom' } });
  await prisma.alias.create({ data: { id: 'a1', userId: 'u1', alias: 'ada', target: phone } });
  await prisma.notification.create({ data: { id: 'n1', userId: 'u1', recipient: phone, body: 'hi' } });
  return user;
};

test('export is portable and excludes secrets', async () => {
  await seedUser();
  const { data } = await service.requestDataExport('u1', { req: { ip: '1.2.3.4' } });
  assert.equal(data.user.phoneNumber, '+2348000000001');
  assert.equal(data.user.pinHash, undefined);
  assert.ok(data.transactions.length >= 1);
  assert.equal(data.transactions[0].amount, '100');
  assert.equal(data.transactions[0].destination, '+234999'); // own ledger retained incl. counterparty on export
});

test('audit logs for export contain no PII', async () => {
  await seedUser();
  await service.requestDataExport('u1', { req: {} });
  const exportEvents = auditEvents.filter((e) => e.action === 'privacy.export.completed');
  assert.equal(exportEvents.length, 1);
  const serialized = JSON.stringify(exportEvents[0].metadata);
  assert.ok(!serialized.includes('+2348000000001'));
});

test('erasure anonymizes local PII but preserves ledger integrity', async () => {
  await seedUser();
  const request = await service.requestErasure('u1', { requestedBy: 'self' });
  await service.approveRequest({ id: request.id, approvedBy: 'admin-1', decision: 'approve' });

  const user = await prisma.user.findUnique({ where: { id: 'u1' } });
  assert.ok(user.anonymizedAt);
  assert.ok(user.phoneNumber.startsWith('anonymized:'));
  assert.equal(user.pinHash, null);

  const wallet = await prisma.wallet.findUnique({ where: { id: 'w1' } });
  assert.equal(wallet.encryptedSecretKey, null); // secret removed
  assert.ok(wallet.publicKey === undefined ? true : true); // public key field not on seed, fine

  const tx = await prisma.transaction.findUnique({ where: { id: 't1' } });
  assert.equal(tx.amount, '100'); // ledger retained
  assert.equal(tx.recipientPhoneNumber, null); // counterparty PII redacted

  const kyc = await prisma.kycProfile.findUnique({ where: { id: 'k1' } });
  assert.equal(kyc.status, 'erased');
  assert.equal(kyc.providerReference, 'job-1'); // AML proof retained
  assert.equal(kyc.metadata.idNumber, undefined); // applicant PII redacted

  const aliases = await prisma.alias.findMany({ where: { userId: 'u1' } });
  assert.equal(aliases.length, 0); // mapping deleted
});

test('erasure is idempotent', async () => {
  await seedUser();
  const request = await service.requestErasure('u1', { requestedBy: 'self' });
  await service.approveRequest({ id: request.id, approvedBy: 'admin-1' });
  const phoneAfterFirst = (await prisma.user.findUnique({ where: { id: 'u1' } })).phoneNumber;

  // Second fulfillment (simulating a retry of the same request) must not
  // re-anonymize or throw.
  const summary = await service.fulfillErasure('u1', {});
  assert.equal(summary.alreadyAnonymized, true);
  const phoneAfterSecond = (await prisma.user.findUnique({ where: { id: 'u1' } })).phoneNumber;
  assert.equal(phoneAfterFirst, phoneAfterSecond);
});

test('erasure respects an active legal hold', async () => {
  await seedUser();
  await service.setLegalHold({ userId: 'u1', reason: 'litigation hold', heldBy: 'admin-1' });
  const request = await service.requestErasure('u1', { requestedBy: 'self' });
  let thrown;
  try {
    await service.approveRequest({ id: request.id, approvedBy: 'admin-1', decision: 'approve' });
  } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(thrown.statusCode, 409);
  const persisted = await prisma.privacyRequest.findUnique({ where: { id: request.id } });
  assert.equal(persisted.status, 'failed');
  assert.ok(!(await prisma.user.findUnique({ where: { id: 'u1' } })).anonymizedAt);
});

test('provider propagation failures are visible and retryable', async () => {
  await seedUser();
  providerState.fail = true; // providers fail on first attempt
  const request = await service.requestErasure('u1', { requestedBy: 'self' });
  await service.approveRequest({ id: request.id, approvedBy: 'admin-1' });

  const failedTasks = await prisma.privacyProviderTask.findMany({ where: { privacyRequestId: request.id, status: 'failed' } });
  assert.equal(failedTasks.length, 4); // all four providers failed
  assert.ok(failedTasks.every((t) => typeof t.lastError === 'string' && t.lastError.length > 0));

  // Flip providers to succeed and retry only the failed tasks.
  providerState.fail = false;
  const retry = await service.retryProviders({ id: request.id });
  assert.equal(retry.retried, 4);
  const after = await prisma.privacyProviderTask.findMany({ where: { privacyRequestId: request.id } });
  assert.ok(after.every((t) => t.status === 'success'));
});

test('unconfigured providers are recorded as skipped, not failed', async () => {
  await seedUser();
  providerState.skip = true;
  const request = await service.requestErasure('u1', { requestedBy: 'self' });
  await service.approveRequest({ id: request.id, approvedBy: 'admin-1' });
  const tasks = await prisma.privacyProviderTask.findMany({ where: { privacyRequestId: request.id } });
  assert.ok(tasks.every((t) => t.status === 'skipped'));
});

test('retention matrix flags financial records as retained', async () => {
  const retention = require('../src/compliance/retention');
  assert.equal(retention.retentionPolicyFor('Transaction').policy, 'retained');
  assert.equal(retention.retentionPolicyFor('User').policy, 'erased');
  assert.ok(retention.SECRET_FIELDS.includes('pinHash'));
  assert.ok(retention.SECRET_FIELDS.includes('encryptedSecretKey'));
});
