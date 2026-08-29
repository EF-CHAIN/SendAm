const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const injectMock = (relativeFromSrc, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

// Mock structures
const mockOriginalTx = {
  id: 'tx_original_123',
  userId: 'user_123',
  type: 'send',
  amount: '100.0000000',
  asset: 'XLM',
  status: 'success',
  recipientPhoneNumber: '+2348011112222',
  destination: 'GABCrecipient',
  metadata: { fee: '1.0000000', refunds: [] },
};

const mockSenderWallet = {
  id: 'sender_wallet_id',
  userId: 'user_123',
  chain: 'stellar',
  publicKey: 'GABCsender',
  phoneNumber: '+2348000000001',
};

const mockRecipientWallet = {
  id: 'recipient_wallet_id',
  userId: 'user_recipient_123',
  chain: 'stellar',
  publicKey: 'GABCrecipient',
  encryptedSecretKey: 'encrypted_secret_key',
};

const createdTransactions = new Map();

// Database queries/mocks
let mockCreatedRefund;
const prismaMock = {
  transaction: {
    findUnique: async ({ where }) => {
      if (where.id === 'tx_original_123') return mockOriginalTx;
      return createdTransactions.get(where.id) || null;
    },
    findMany: async ({ where }) => {
      const list = Array.from(createdTransactions.values());
      if (where.type === 'refund' && where.status === 'success') {
        return list.filter((tx) => tx.type === 'refund' && tx.status === 'success');
      }
      return list;
    },
    create: async ({ data }) => {
<<<<<<< HEAD
      mockCreatedRefund = { id: 'refund_tx_new', status: 'processing', ...data };
      return mockCreatedRefund;
=======
      const tx = { id: 'refund_tx_new', status: 'processing', ...data };
      createdTransactions.set(tx.id, tx);
      return { ...tx };
>>>>>>> upstream/main
    },
    update: async ({ where, data }) => {
      if (where.id === 'tx_original_123') {
        mockOriginalTx.metadata = data.metadata;
        return mockOriginalTx;
      }
<<<<<<< HEAD
      return { ...(where.id === 'refund_tx_new' ? mockCreatedRefund : {}), id: where.id, ...data };
=======
      const existing = createdTransactions.get(where.id) || { id: where.id };
      const updated = { ...existing, ...data, metadata: { ...(existing.metadata || {}), ...(data.metadata || {}) } };
      createdTransactions.set(where.id, updated);
      return { ...updated };
>>>>>>> upstream/main
    },
  },
  wallet: {
    findUnique: async ({ where }) => {
      if (where.userId_chain && where.userId_chain.userId === 'user_123') return mockSenderWallet;
      if (where.userId_chain && where.userId_chain.userId === 'user_recipient_123') return mockRecipientWallet;
      return null;
    },
    findFirst: async ({ where }) => {
      if (where.publicKey === 'GABCrecipient') return mockRecipientWallet;
      return null;
    },
  },
  user: {
    findFirst: async ({ where }) => {
      if (where.phoneNumber === '+2348011112222') return { id: 'user_recipient_123' };
      return null;
    },
  },
  auditLog: {
    create: async () => ({}),
  },
};

const cryptoServiceMock = {
  decrypt: () => 'SA_RECIPIENT_SECRET',
  encrypt: () => 'encrypted',
};

const stellarAdapterMock = {
  submitPayment: async ({ secretKey, destination, asset }) => {
    assert.equal(secretKey, 'SA_RECIPIENT_SECRET');
    assert.equal(destination, 'GABCsender');
    assert.equal(asset, 'XLM');
    return {
      txHash: 'stellar_refund_hash_123',
      explorerUrl: 'https://stellar.expert/refund_hash',
    };
  },
};

injectMock('common/prisma', prismaMock);
injectMock('services/crypto.service', cryptoServiceMock);
injectMock('wallet/stellar.adapter', stellarAdapterMock);
injectMock('wallet/wallet.service', {});

const { executeRefund } = require('../src/payment/payment.orchestrator');

test('executeRefund: performs successful refund and updates metadata link', async () => {
  const result = await executeRefund({
    transactionId: 'tx_original_123',
    reason: 'failed_fulfillment',
    amount: '50.0000000',
    adminId: 'admin_test',
  });

  assert.equal(result.status, 'success');
  assert.equal(result.txHash, 'stellar_refund_hash_123');
  assert.equal(result.amount, '50.0000000');
  assert.equal(result.metadata.refundReason, 'failed_fulfillment');
  assert.equal(result.metadata.originalTransactionId, 'tx_original_123');

  // Check linking in original transaction's metadata
  assert.ok(mockOriginalTx.metadata.refunds);
  assert.equal(mockOriginalTx.metadata.refunds.length, 1);
  assert.equal(mockOriginalTx.metadata.refunds[0].amount, '50.0000000');
  assert.equal(mockOriginalTx.metadata.refunds[0].reason, 'failed_fulfillment');
});

test('executeRefund: rejects invalid refund reason', async () => {
  await assert.rejects(
    () => executeRefund({
      transactionId: 'tx_original_123',
      reason: 'wrong_reason',
      adminId: 'admin_test',
    }),
    /Invalid refund reason/
  );
});

test('executeRefund: prevents refund amount exceeding original transaction amount', async () => {
  // Try to refund more than the original settled amount.
  await assert.rejects(
    () => executeRefund({
      transactionId: 'tx_original_123',
      reason: 'operator_mistake',
      amount: '150.0000000',
      adminId: 'admin_test',
    }),
    /Refund amount exceeds the maximum refundable amount/
  );
});
