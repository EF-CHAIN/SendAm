const { test } = require('node:test');
const assert = require('node:assert/strict');

const { anonymizeUser, buildRetentionMatrix, withErasureGuard } = require('../src/services/userErasure.service');

test('retention matrix marks regulated records as immutable and retained', () => {
  const matrix = buildRetentionMatrix();

  assert.equal(matrix.User.mode, 'anonymize');
  assert.equal(matrix.Transaction.mode, 'retain');
  assert.equal(matrix.AuditLog.preserve, 'immutable');
  assert.equal(matrix.Wallet.mode, 'anonymize');
  assert.equal(typeof buildRetentionMatrix, 'function');
});

test('anonymizeUser preserves evidence while clearing personal data', async () => {
  const calls = [];
  const db = {
    user: {
      findUnique: async ({ where }) => ({
        id: where.id,
        phoneNumber: '+2348000000001',
        whatsappName: 'Alice Demo',
        pinHash: 'old-pin-hash',
        pinSetAt: new Date('2024-01-01T00:00:00Z'),
        pendingSend: { foo: 'bar' },
        contactsJson: { some: 'data' },
      }),
      update: async ({ where, data }) => {
        calls.push(['user.update', where, data]);
        return { id: where.id, ...data };
      },
    },
    wallet: {
      updateMany: async ({ where, data }) => {
        calls.push(['wallet.updateMany', where, data]);
        return { count: 1 };
      },
    },
    contact: {
      updateMany: async ({ where, data }) => {
        calls.push(['contact.updateMany', where, data]);
        return { count: 2 };
      },
    },
    alias: {
      updateMany: async ({ where, data }) => {
        calls.push(['alias.updateMany', where, data]);
        return { count: 1 };
      },
    },
    transaction: {
      updateMany: async ({ where, data }) => {
        calls.push(['transaction.updateMany', where, data]);
        return { count: 3 };
      },
    },
    kycProfile: {
      updateMany: async ({ where, data }) => {
        calls.push(['kycProfile.updateMany', where, data]);
        return { count: 1 };
      },
    },
    voiceCommand: {
      updateMany: async ({ where, data }) => {
        calls.push(['voiceCommand.updateMany', where, data]);
        return { count: 1 };
      },
    },
    notification: {
      updateMany: async ({ where, data }) => {
        calls.push(['notification.updateMany', where, data]);
        return { count: 1 };
      },
    },
    quote: {
      updateMany: async ({ where, data }) => {
        calls.push(['quote.updateMany', where, data]);
        return { count: 1 };
      },
    },
    userErasure: {
      findUnique: async () => null,
      create: async ({ data }) => {
        calls.push(['userErasure.create', data]);
        return { id: 'erasure-1', ...data };
      },
    },
  };

  const result = await anonymizeUser(db, {
    userId: 'user-123',
    actorId: 'admin-42',
    actorType: 'admin',
    reason: 'user-requested',
    jurisdiction: 'NG',
    legalHold: false,
  });

  assert.equal(result.status, 'anonymized');
  assert.equal(result.user.phoneNumber, 'deleted-user-user-123');
  assert.ok(calls.some(([op, , data]) => op === 'wallet.updateMany' && data.publicKey === null));
  assert.ok(calls.some(([op, , data]) => op === 'transaction.updateMany' && data.recipientPhoneNumber === null));
  assert.ok(calls.some(([op, data]) => op === 'userErasure.create' && data.jurisdiction === 'NG'));
});

test('raw user deletes are blocked to force the retention workflow', () => {
  const db = {
    user: {
      delete: () => { throw new Error('should not call delete'); },
      deleteMany: () => { throw new Error('should not call deleteMany'); },
    },
  };

  const guarded = withErasureGuard(db);
  assert.throws(() => guarded.user.delete(), /Use anonymizeUser/);
  assert.throws(() => guarded.user.deleteMany(), /Use anonymizeUser/);
});
