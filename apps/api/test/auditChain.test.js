const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const logs = [];
let head = null;
const prisma = {
  $transaction: async (callback) => callback({
    auditChainHead: {
      findUnique: async () => head,
      create: async ({ data }) => {
        head = data;
        return head;
      },
      update: async ({ data }) => {
        head = { ...head, ...data };
        return head;
      },
    },
    auditLog: {
      findFirst: async () => logs.at(-1) || null,
      create: async ({ data }) => {
        const record = { id: `audit-${logs.length + 1}`, ...data };
        logs.push(record);
        return record;
      },
    },
  }),
  auditChainHead: { findUnique: async () => head },
  auditLog: { findMany: async () => logs },
};

const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
inject('common/prisma', prisma);
inject('utils/logger', { error: () => {} });
inject('config/proxy', { getClientIp: () => null });
inject('config/env', { encryptionKey: 'test-key' });
const { writeAuditLog, verifyAuditLogIntegrity } = require('../src/common/audit.service');

test('SHA-256 audit chain verifies records and detects deletion', async () => {
  await writeAuditLog({ action: 'first' });
  await writeAuditLog({ action: 'second' });
  assert.equal(logs[0].hashAlgorithm, 'sha256');
  assert.equal((await verifyAuditLogIntegrity()).valid, true);

  logs.splice(0, 1);
  const verification = await verifyAuditLogIntegrity();
  assert.equal(verification.valid, false);
  assert.ok(verification.errors.some(({ issue }) => issue.includes('broken')));
});
