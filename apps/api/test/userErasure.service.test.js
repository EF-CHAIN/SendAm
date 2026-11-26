'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  anonymizeUser,
  buildRetentionMatrix,
  withErasureGuard,
  generateTombstoneHash,
  deleteKycFiles,
} = require('../src/services/userErasure.service');

test('retention matrix marks regulated records as immutable and retained', () => {
  const matrix = buildRetentionMatrix();

  assert.equal(matrix.User.mode, 'anonymize');
  assert.equal(matrix.Transaction.mode, 'retain');
  assert.equal(matrix.AuditLog.preserve, 'immutable');
  assert.equal(matrix.Wallet.mode, 'anonymize');
  assert.equal(typeof buildRetentionMatrix, 'function');
});

test('generateTombstoneHash produces a 32-character random hex string', () => {
  const hash1 = generateTombstoneHash();
  const hash2 = generateTombstoneHash();

  assert.match(hash1, /^[a-f0-9]{32}$/);
  assert.match(hash2, /^[a-f0-9]{32}$/);
  assert.notEqual(hash1, hash2);
});

test('deleteKycFiles unlinks candidate files across documentPath, filePath, and metadata.files', async () => {
  const unlinked = [];
  const fakeFs = {
    promises: {
      unlink: async (filePath) => {
        unlinked.push(filePath);
      },
    },
  };

  const kycProfile = {
    documentPath: '/var/data/kyc/doc1.jpg',
    filePath: '/var/data/kyc/selfie1.png',
    metadata: {
      files: ['/var/data/kyc/proof_of_address.pdf', { path: '/var/data/kyc/id_back.jpg' }],
    },
  };

  const result = await deleteKycFiles(kycProfile, { fileSystem: fakeFs });

  assert.equal(result.deletedCount, 4);
  assert.deepEqual(unlinked, [
    '/var/data/kyc/doc1.jpg',
    '/var/data/kyc/selfie1.png',
    '/var/data/kyc/proof_of_address.pdf',
    '/var/data/kyc/id_back.jpg',
  ]);
});

test('anonymizeUser executes GDPR/NDPR erasure pipeline with cryptographic tombstoning', async () => {
  const calls = [];
  const unlinkedFiles = [];
  const fakeFs = {
    promises: {
      unlink: async (p) => { unlinkedFiles.push(p); },
    },
  };

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
        legalHold: false,
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
      findUnique: async () => ({
        id: 'k1',
        documentPath: '/tmp/kyc/user-123-id.jpg',
        metadata: { files: ['/tmp/kyc/user-123-selfie.jpg'] },
      }),
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
    restSession: {
      updateMany: async ({ where, data }) => {
        calls.push(['restSession.updateMany', where, data]);
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
    reason: 'gdpr-erasure-request',
    jurisdiction: 'NG',
    legalHold: false,
    fileSystem: fakeFs,
  });

  assert.equal(result.status, 'anonymized');

  // AC1: Random cryptographic tombstone hash for phoneNumber
  assert.match(result.user.phoneNumber, /^anonymized:[a-f0-9]{32}$/);
  assert.ok(!result.user.phoneNumber.includes('user-123'), 'should not leak userId in anonymized phone');
  assert.ok(!result.user.phoneNumber.includes('+2348000000001'), 'should not leak original phone');

  // AC2: Nullify WhatsApp name
  assert.equal(result.user.whatsappName, null, 'whatsappName must be nullified');

  // AC3: Mark anonymizedAt timestamp
  assert.ok(result.user.anonymizedAt instanceof Date, 'anonymizedAt must be set to Date');
  assert.equal(result.user.pinHash, null);

  // AC4: Delete unencrypted KYC files
  assert.equal(unlinkedFiles.length, 2);
  assert.ok(unlinkedFiles.includes('/tmp/kyc/user-123-id.jpg'));
  assert.ok(unlinkedFiles.includes('/tmp/kyc/user-123-selfie.jpg'));

  // AC5: Redact PII in transactions while preserving transaction existence & accounting fields
  const txUpdate = calls.find(([op]) => op === 'transaction.updateMany');
  assert.ok(txUpdate);
  assert.equal(txUpdate[2].recipientPhoneNumber, null);
  assert.equal(txUpdate[2].destination, null);
  assert.equal(txUpdate[2].metadata.retention, 'retained-for-regulatory-purposes');
  assert.equal(txUpdate[2].metadata.redacted, true);

  // AC6: Redact IP address on rest sessions
  const sessionUpdate = calls.find(([op]) => op === 'restSession.updateMany');
  assert.ok(sessionUpdate);
  assert.equal(sessionUpdate[2].ipAddress, null);

  // AC7: UserErasure record created
  assert.ok(calls.some(([op, data]) => op === 'userErasure.create' && data.jurisdiction === 'NG'));
});

test('anonymizeUser blocks erasure if user is marked under legal hold', async () => {
  const db = {
    user: {
      findUnique: async () => ({
        id: 'u-held',
        legalHold: true,
      }),
    },
  };

  await assert.rejects(
    async () => {
      await anonymizeUser(db, { userId: 'u-held' });
    },
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'LEGAL_HOLD_ACTIVE');
      return true;
    }
  );
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
