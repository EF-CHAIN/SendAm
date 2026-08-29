const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.ENCRYPTION_KEY = 'a'.repeat(64);

const injectMock = (relativeFromSrc, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

const auditLogs = [];
injectMock('common/audit.service', {
  writeAuditLog: async (log) => {
    auditLogs.push(log);
    return { id: `audit_${auditLogs.length}`, ...log };
  },
});

const { encrypt, decrypt } = require('../src/services/crypto.service');

const mockWallet = {
  id: 'wallet_123',
  userId: 'user_u1',
  chain: 'stellar',
  publicKey: 'GABC123OLD',
  encryptedSecretKey: encrypt('S_SECRET_123', 'v1'),
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockUser = {
  id: 'user_u1',
  phoneNumber: '+2348011112222',
};

const dbMock = {
  user: {
    findUnique: async ({ where }) => {
      if (where.id === 'user_u1') return mockUser;
      return null;
    },
  },
  wallet: {
    findUnique: async ({ where }) => {
      if (where.id === 'wallet_123') return { ...mockWallet };
      return null;
    },
    update: async ({ where, data }) => {
      Object.assign(mockWallet, data);
      return { ...mockWallet };
    },
  },
};

injectMock('common/prisma', dbMock);

const {
  rotateWalletKey,
  initiateWalletRecovery,
  completeWalletRecovery,
} = require('../src/wallet/walletRecovery.service');

test('rotateWalletKey re-encrypts secret key with target version and writes audit log', async () => {
  const initialAuditCount = auditLogs.length;

  const result = await rotateWalletKey({
    walletId: 'wallet_123',
    targetKeyVersion: 'v1',
    actorId: 'admin_1',
    actorType: 'administrator',
    db: dbMock,
  });

  assert.equal(result.success, true);
  assert.equal(result.walletId, 'wallet_123');

  // Verify decrypted secret key matches
  const decrypted = decrypt(mockWallet.encryptedSecretKey);
  assert.equal(decrypted, 'S_SECRET_123');

  // Verify audit log was recorded
  assert.ok(auditLogs.length > initialAuditCount);
  const rotationLog = auditLogs.find((l) => l.action === 'wallet.rotation.succeeded');
  assert.ok(rotationLog);
  assert.equal(rotationLog.entityId, 'wallet_123');
});

test('initiateWalletRecovery rejects if wallet ownership does not match user', async () => {
  await assert.rejects(
    async () => {
      await initiateWalletRecovery({
        userId: 'user_u1',
        walletId: 'non_existent_wallet',
        reason: 'Lost phone',
        verificationProof: 'kyc_proof_123',
        db: dbMock,
      });
    },
    { statusCode: 403 }
  );

  const deniedLog = auditLogs.find((l) => l.action === 'wallet.recovery.denied');
  assert.ok(deniedLog);
});

test('initiateWalletRecovery creates cooling-off record and audit log', async () => {
  const recovery = await initiateWalletRecovery({
    userId: 'user_u1',
    walletId: 'wallet_123',
    reason: 'Lost phone',
    verificationProof: 'kyc_proof_123',
    db: dbMock,
  });

  assert.ok(recovery.recoveryId.startsWith('rec_wallet_123'));
  assert.equal(recovery.status, 'cooling_off');
  assert.ok(new Date(recovery.coolingOffUntil) > new Date());

  const initLog = auditLogs.find((l) => l.action === 'wallet.recovery.initiated');
  assert.ok(initLog);
});

test('completeWalletRecovery rejects during cooling-off period', async () => {
  const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();
  const recoveryState = {
    recoveryId: 'rec_test',
    walletId: 'wallet_123',
    status: 'cooling_off',
    coolingOffUntil: futureDate,
  };

  await assert.rejects(
    async () => {
      await completeWalletRecovery({ recoveryState, db: dbMock });
    },
    { statusCode: 400 }
  );
});

test('completeWalletRecovery succeeds when cooling-off has passed', async () => {
  const pastDate = new Date(Date.now() - 1000).toISOString();
  const recoveryState = {
    recoveryId: 'rec_test_2',
    walletId: 'wallet_123',
    status: 'cooling_off',
    coolingOffUntil: pastDate,
  };

  const result = await completeWalletRecovery({ recoveryState, db: dbMock });

  assert.equal(result.success, true);
  assert.equal(result.status, 'completed');
  assert.ok(result.newPublicKey);

  const completedLog = auditLogs.find((l) => l.action === 'wallet.recovery.completed');
  assert.ok(completedLog);
});
