const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const matches = (row, where) => {
  if (!where || Object.keys(where).length === 0) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return cond.some((sub) => matches(row, sub));
    if (key === 'AND') return cond.every((sub) => matches(row, sub));
    if (key === 'user' || key === 'wallet') return matches(row[key] || {}, cond);
    const value = row[key];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      return Object.entries(cond).every(([op, operand]) => {
        const eq = (a, b) => (a instanceof Date || b instanceof Date)
          ? new Date(a).getTime() === new Date(b).getTime()
          : a === b;
        switch (op) {
          case 'equals': return eq(value, operand);
          case 'contains': return String(value).toLowerCase().includes(String(operand).toLowerCase());
          case 'gte': return new Date(value) >= new Date(operand);
          case 'lte': return new Date(value) <= new Date(operand);
          case 'gt': return new Date(value) > new Date(operand);
          case 'lt': return new Date(value) < new Date(operand);
          default: return false;
        }
      });
    }
    return eq(value, cond);
  });
};

const makeDelegate = (rows) => ({
  findMany: async ({ where = {}, orderBy = [], take } = {}) => {
    const ob = Array.isArray(orderBy) ? orderBy : [orderBy];
    const sorted = [...rows].sort((a, b) => {
      for (const o of ob) {
        const [field, dir] = Object.entries(o)[0];
        if (a[field] < b[field]) return dir === 'asc' ? -1 : 1;
        if (a[field] > b[field]) return dir === 'asc' ? 1 : -1;
      }
      return 0;
    });
    return take == null ? sorted : sorted.filter((r) => matches(r, where)).slice(0, take);
  },
  count: async ({ where = {} } = {}) => rows.filter((r) => matches(r, where)).length,
});

const auditCalls = [];
const users = [
  { id: 'u1', phoneNumber: '+111', createdAt: new Date(2024, 0, 3), whatsappName: 'A' },
  { id: 'u2', phoneNumber: '+222', createdAt: new Date(2024, 0, 2), whatsappName: 'B' },
  { id: 'u3', phoneNumber: '+333', createdAt: new Date(2024, 0, 1), whatsappName: 'C' },
];
const transactions = [
  { id: 't1', status: 'success', asset: 'USDC', rail: 'stellar', userId: 'u1', user: { phoneNumber: '+111' }, txHash: 'hash1', createdAt: new Date(2024, 0, 3) },
  { id: 't2', status: 'failed', asset: 'XLM', rail: 'stellar', userId: 'u2', user: { phoneNumber: '+222' }, txHash: 'hash2', createdAt: new Date(2024, 0, 2) },
];
const kycProfiles = [
  { id: 'k1', status: 'pending', country: 'NG', user: { phoneNumber: '+111' }, updatedAt: new Date(2024, 0, 3) },
  { id: 'k2', status: 'approved', country: 'GH', user: { phoneNumber: '+222' }, updatedAt: new Date(2024, 0, 2) },
];
const auditLogs = [
  { id: 'a1', actorType: 'administrator', action: 'admin.login', entityType: 'AdminSession', createdAt: new Date(2024, 0, 3) },
  { id: 'a2', actorType: 'system', action: 'admin.logout', entityType: 'AdminSession', createdAt: new Date(2024, 0, 2) },
];

const fakePrisma = {
  user: makeDelegate(users),
  wallet: makeDelegate([]),
  transaction: makeDelegate(transactions),
  kycProfile: makeDelegate(kycProfiles),
  auditLog: {
    ...makeDelegate(auditLogs),
    findFirst: async () => auditLogs[0],
    create: async (args) => { auditCalls.push(args.data); return { id: 'audit-new', ...args.data }; },
  },
};
fakePrisma.$transaction = async (cb) => cb(fakePrisma);

const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
inject('../src/common/prisma', fakePrisma);
inject('../src/config/env', { admin: { sessionTtlHours: 12 }, jwtSecret: 'test-secret' });

const controller = require('../src/controllers/admin.controller');

const makeRes = () => {
  const res = { statusCode: 200, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.send = (data) => { res.sent = data; return res; };
  return res;
};
const makeReq = (query = {}) => ({ query, admin: { id: 'admin-test', permissions: ['*'] } });

beforeEach(() => { auditCalls.length = 0; });

test('users list is cursor-paginated and bounded', async () => {
  const res = makeRes();
  await controller.getUsers(makeReq({ limit: '2' }), res, () => {});
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.length, 2);
  assert.equal(res.body.pagination.limit, 2);
  assert.equal(res.body.pagination.hasMore, true);
  assert.ok(res.body.pagination.nextCursor);
  assert.equal(res.body.pagination.total, 3);
});

test('limit is capped at the maximum page size', async () => {
  const res = makeRes();
  await controller.getUsers(makeReq({ limit: '99999' }), res, () => {});
  assert.equal(res.body.pagination.limit, 100);
});

test('invalid cursor returns 400', async () => {
  let captured;
  await controller.getUsers(makeReq({ after: '%%%not-a-cursor' }), makeRes(), (e) => { captured = e; });
  assert.ok(captured);
  assert.equal(captured.statusCode, 400);
});

test('transaction filters apply server-side', async () => {
  let res = makeRes();
  await controller.getTransactions(makeReq({ status: 'success' }), res, () => {});
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0]._id, 't1');

  res = makeRes();
  await controller.getTransactions(makeReq({ identifier: 'hash2' }), res, () => {});
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0]._id, 't2');

  res = makeRes();
  await controller.getTransactions(makeReq({ asset: 'XLM' }), res, () => {});
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0]._id, 't2');
});

test('kyc status filter and audit action filter', async () => {
  let res = makeRes();
  await controller.getKycProfiles(makeReq({ status: 'pending' }), res, () => {});
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0]._id, 'k1');

  res = makeRes();
  await controller.getAuditLogs(makeReq({ action: 'admin.login' }), res, () => {});
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0]._id, 'a1');
});

test('empty result set returns no rows and total 0', async () => {
  const res = makeRes();
  await controller.getTransactions(makeReq({ status: 'nope' }), res, () => {});
  assert.equal(res.body.data.length, 0);
  assert.equal(res.body.pagination.total, 0);
  assert.equal(res.body.pagination.hasMore, false);
});

test('kyc export is authorized, bounded, and audited', async () => {
  const res = makeRes();
  await controller.exportKyc(makeReq(), res, () => {});
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /text\/csv/);
  assert.match(res.sent, /id,phoneNumber/);
  assert.ok(auditCalls.some((c) => c.action === 'admin.kyc.export'));
});

test('audit export is audited', async () => {
  const res = makeRes();
  await controller.exportAuditLogs(makeReq(), res, () => {});
  assert.equal(res.statusCode, 200);
  assert.ok(auditCalls.some((c) => c.action === 'admin.audit.export'));
});
