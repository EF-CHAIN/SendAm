'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.STELLAR_NETWORK = 'testnet';

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

const workflowEvents = [];
injectMock('common/event.service', {
  EVENT_TYPES: { WALLET_FREEZE: 'wallet.emergency_freeze' },
  appendEvent: async (evt) => {
    workflowEvents.push(evt);
    return { id: `evt_${workflowEvents.length}`, ...evt };
  },
});

const { encrypt } = require('../src/services/crypto.service');
const StellarSdk = require('@stellar/stellar-sdk');

const compromisedMasterKeypair = StellarSdk.Keypair.random();
const platformRecoveryKeypair = StellarSdk.Keypair.random();

const mockWallet = {
  id: 'wallet_freeze_test_1',
  userId: 'user_compromised_1',
  chain: 'stellar',
  network: 'testnet',
  networkProvenance: 'verified',
  publicKey: compromisedMasterKeypair.publicKey(),
  encryptedSecretKey: encrypt(compromisedMasterKeypair.secret(), 'v1'),
  funded: true,
  fundingState: 'succeeded',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockUser = {
  id: 'user_compromised_1',
  phoneNumber: '+2348099990000',
  deactivatedAt: null,
};

const mockTransactions = [
  {
    id: 'tx_pending_1',
    userId: 'user_compromised_1',
    status: 'pending',
    amount: '100.00',
    metadata: { note: 'Pending payment 1' },
  },
  {
    id: 'tx_processing_2',
    userId: 'user_compromised_1',
    status: 'processing',
    amount: '50.00',
    metadata: { note: 'Processing payment 2' },
  },
  {
    id: 'tx_settled_3',
    userId: 'user_compromised_1',
    status: 'settled',
    amount: '20.00',
    metadata: { note: 'Already settled' },
  },
];

const mockRecurringPayments = [
  {
    id: 'rec_1',
    userId: 'user_compromised_1',
    status: 'active',
  },
];

const createDbMock = () => {
  const wallets = [JSON.parse(JSON.stringify(mockWallet))];
  const users = [JSON.parse(JSON.stringify(mockUser))];
  const txs = JSON.parse(JSON.stringify(mockTransactions));
  const recurring = JSON.parse(JSON.stringify(mockRecurringPayments));

  return {
    wallet: {
      findUnique: async ({ where }) => wallets.find((w) => w.id === where.id) || null,
      update: async ({ where, data }) => {
        const w = wallets.find((item) => item.id === where.id);
        if (w) Object.assign(w, data);
        return w;
      },
    },
    user: {
      findUnique: async ({ where }) => users.find((u) => u.id === where.id) || null,
      update: async ({ where, data }) => {
        const u = users.find((item) => item.id === where.id);
        if (u) Object.assign(u, data);
        return u;
      },
    },
    transaction: {
      findMany: async ({ where }) => {
        return txs.filter((t) => {
          if (where.userId && t.userId !== where.userId) return false;
          if (where.status?.in && !where.status.in.includes(t.status)) return false;
          return true;
        });
      },
      update: async ({ where, data }) => {
        const t = txs.find((item) => item.id === where.id);
        if (t) Object.assign(t, data);
        return t;
      },
    },
    recurringPayment: {
      updateMany: async ({ where, data }) => {
        let count = 0;
        recurring.forEach((r) => {
          if (r.userId === where.userId && (!where.status?.in || where.status.in.includes(r.status))) {
            Object.assign(r, data);
            count += 1;
          }
        });
        return { count };
      },
    },
  };
};

const createMockServer = ({ shouldFailOnChain = false, notFound = false } = {}) => {
  let submittedTransaction = null;
  return {
    loadAccount: async (publicKey) => {
      if (notFound) {
        const err = new Error('Account not found');
        err.response = { status: 404 };
        throw err;
      }
      return new StellarSdk.Account(publicKey, '1000');
    },
    fetchBaseFee: async () => 100,
    submitTransaction: async (tx) => {
      if (shouldFailOnChain) {
        throw new Error('Horizon submission error: op_underfunded');
      }
      submittedTransaction = tx;
      return {
        hash: 'mock_tx_hash_' + Date.now(),
        id: 'mock_tx_id_' + Date.now(),
      };
    },
    getSubmittedTransaction: () => submittedTransaction,
  };
};

const {
  emergencyFreezeWallet,
  setEmergencySigners,
  resolveRecoverySignerPublicKey,
  cancelPendingTransactions,
  emergencyFreezeHandler,
} = require('../src/wallet/emergencyFreeze');

test('resolveRecoverySignerPublicKey validates valid Ed25519 public key and rejects invalid', () => {
  const validKey = platformRecoveryKeypair.publicKey();
  assert.equal(resolveRecoverySignerPublicKey(validKey), validKey);

  assert.throws(
    () => resolveRecoverySignerPublicKey('INVALID_PUBLIC_KEY'),
    { statusCode: 400 },
  );

  // When omitted, generates a valid Ed25519 fallback key
  const fallback = resolveRecoverySignerPublicKey(null);
  assert.ok(StellarSdk.StrKey.isValidEd25519PublicKey(fallback));
});

test('setEmergencySigners builds and submits setOptions with masterWeight 0 and recovery signer weight 1', async () => {
  const mockServer = createMockServer();
  const recoveryPublicKey = platformRecoveryKeypair.publicKey();

  const result = await setEmergencySigners({
    publicKey: compromisedMasterKeypair.publicKey(),
    secretKey: compromisedMasterKeypair.secret(),
    recoverySignerPublicKey: recoveryPublicKey,
    server: mockServer,
  });

  assert.equal(result.onChainApplied, true);
  assert.equal(result.masterWeight, 0);
  assert.equal(result.recoverySignerWeight, 1);
  assert.deepEqual(result.thresholds, { low: 1, med: 1, high: 1 });
  assert.ok(result.txHash);

  const tx = mockServer.getSubmittedTransaction();
  assert.ok(tx);
  assert.equal(tx.operations.length, 1);
  const op = tx.operations[0];
  assert.equal(op.type, 'setOptions');
  assert.equal(op.masterWeight, 0);
  assert.equal(op.lowThreshold, 1);
  assert.equal(op.medThreshold, 1);
  assert.equal(op.highThreshold, 1);
  assert.equal(op.signer.ed25519PublicKey, recoveryPublicKey);
  assert.equal(op.signer.weight, 1);
});

test('emergencyFreezeWallet rejects unknown wallet with 404', async () => {
  const db = createDbMock();
  await assert.rejects(
    async () => {
      await emergencyFreezeWallet({
        walletId: 'non_existent_wallet',
        db,
      });
    },
    { statusCode: 404 },
  );
});

test('emergencyFreezeWallet performs complete end-to-end freeze and cancels pending transactions', async () => {
  const db = createDbMock();
  const mockServer = createMockServer();
  const recoveryPublicKey = platformRecoveryKeypair.publicKey();
  const initialAuditCount = auditLogs.length;

  const result = await emergencyFreezeWallet({
    walletId: 'wallet_freeze_test_1',
    recoverySignerPublicKey: recoveryPublicKey,
    reason: 'Reported phone theft on transit',
    adminId: 'admin_ops_42',
    db,
    server: mockServer,
  });

  assert.equal(result.success, true);
  assert.equal(result.walletId, 'wallet_freeze_test_1');
  assert.equal(result.recoverySignerPublicKey, recoveryPublicKey);
  assert.equal(result.masterWeight, 0);
  assert.equal(result.recoverySignerWeight, 1);
  assert.equal(result.onChainApplied, true);
  assert.equal(result.cancelledTransactionsCount, 2); // tx_pending_1 and tx_processing_2
  assert.deepEqual(result.cancelledTransactionIds, ['tx_pending_1', 'tx_processing_2']);

  // Verify DB transaction state
  const pendingTxs = await db.transaction.findMany({ where: { userId: 'user_compromised_1' } });
  const tx1 = pendingTxs.find((t) => t.id === 'tx_pending_1');
  const tx2 = pendingTxs.find((t) => t.id === 'tx_processing_2');
  const tx3 = pendingTxs.find((t) => t.id === 'tx_settled_3');

  assert.equal(tx1.status, 'cancelled');
  assert.ok(tx1.metadata.cancelledAt);
  assert.match(tx1.metadata.cancellationReason, /Reported phone theft/);
  assert.equal(tx2.status, 'cancelled');
  assert.equal(tx3.status, 'settled'); // Settled was not cancelled

  // Verify user was deactivated
  const user = await db.user.findUnique({ where: { id: 'user_compromised_1' } });
  assert.ok(user.deactivatedAt);

  // Verify Audit Log was recorded
  assert.ok(auditLogs.length > initialAuditCount);
  const freezeAudit = auditLogs.find((l) => l.action === 'wallet.emergency_freeze' && l.entityId === 'wallet_freeze_test_1');
  assert.ok(freezeAudit);
  assert.equal(freezeAudit.metadata.recoverySignerPublicKey, recoveryPublicKey);
  assert.equal(freezeAudit.metadata.cancelledTransactionsCount, 2);

  // Verify Workflow Event was appended
  const freezeEvent = workflowEvents.find((e) => e.eventType === 'wallet.emergency_freeze');
  assert.ok(freezeEvent);
  assert.equal(freezeEvent.aggregateId, 'wallet_freeze_test_1');
});

test('emergencyFreezeWallet handles unfunded on-chain account gracefully', async () => {
  const db = createDbMock();
  const mockServer = createMockServer({ notFound: true });

  const result = await emergencyFreezeWallet({
    walletId: 'wallet_freeze_test_1',
    reason: 'Unauthorized access attempt',
    adminId: 'admin_ops_99',
    db,
    server: mockServer,
  });

  assert.equal(result.success, true);
  assert.equal(result.onChainApplied, false);
  assert.equal(result.cancelledTransactionsCount, 2);
});

test('emergencyFreezeHandler Express controller returns 200 with result', async () => {
  const db = createDbMock();
  const mockServer = createMockServer();
  const recoveryPublicKey = platformRecoveryKeypair.publicKey();

  const req = {
    params: { id: 'wallet_freeze_test_1' },
    body: {
      recoverySignerPublicKey: recoveryPublicKey,
      reason: 'Stolen smartphone reported by customer',
    },
    admin: { id: 'admin_123' },
    db,
    server: mockServer,
  };

  let responseData = null;
  let responseStatusCode = null;

  const res = {
    status: (code) => {
      responseStatusCode = code;
      return res;
    },
    json: (data) => {
      responseData = data;
      return res;
    },
  };

  await emergencyFreezeHandler(req, res, (err) => {
    if (err) throw err;
  });

  assert.equal(responseStatusCode, 200);
  assert.equal(responseData.success, true);
  assert.equal(responseData.data.walletId, 'wallet_freeze_test_1');
  assert.equal(responseData.data.recoverySignerPublicKey, recoveryPublicKey);
});

test('compromised account with masterWeight 0 cannot satisfy threshold of 1', () => {
  // Simulate account signers and thresholds on Stellar after emergency freeze
  const accountSigners = [
    { key: compromisedMasterKeypair.publicKey(), weight: 0 },
    { key: platformRecoveryKeypair.publicKey(), weight: 1 },
  ];
  const thresholds = { low: 1, med: 1, high: 1 };

  // Calculate signature weight if signed only by compromised master key
  const signaturesFromCompromised = [compromisedMasterKeypair.publicKey()];
  const compromisedWeight = signaturesFromCompromised.reduce((sum, key) => {
    const signer = accountSigners.find((s) => s.key === key);
    return sum + (signer ? signer.weight : 0);
  }, 0);

  // Compromised key alone has weight 0 < threshold 1 -> rejected
  assert.equal(compromisedWeight, 0);
  assert.ok(compromisedWeight < thresholds.med, 'Compromised account must not satisfy med threshold for transactions');

  // Recovery key alone has weight 1 >= threshold 1 -> accepted
  const signaturesFromRecovery = [platformRecoveryKeypair.publicKey()];
  const recoveryWeight = signaturesFromRecovery.reduce((sum, key) => {
    const signer = accountSigners.find((s) => s.key === key);
    return sum + (signer ? signer.weight : 0);
  }, 0);
  assert.equal(recoveryWeight, 1);
  assert.ok(recoveryWeight >= thresholds.med, 'Platform recovery signer satisfies threshold for recovery operations');
});

