const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const srcRoot = path.resolve(__dirname, '../src');
const injectMock = (relFromSrc, exports) => {
  const filename = path.resolve(srcRoot, `${relFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

let mockUsers = {};
let mockTransactions = [];
let mockAuditLogs = [];
let mockStellarBalances = [];
let mockStellarShouldFail = false;

const prismaMock = {
  user: {
    findUnique: async ({ where }) => {
      const user = mockUsers[where.id];
      if (!user) return null;
      return user;
    },
  },
  transaction: {
    findMany: async ({ where, orderBy: _orderBy, take }) => {
      let filtered = [...mockTransactions];
      if (where?.userId) {
        filtered = filtered.filter((tx) => tx.userId === where.userId);
      }
      if (where?.createdAt?.gte) {
        filtered = filtered.filter((tx) => new Date(tx.createdAt) >= where.createdAt.gte);
      }
      if (where?.createdAt?.lte) {
        filtered = filtered.filter((tx) => new Date(tx.createdAt) <= where.createdAt.lte);
      }
      if (where?.asset) {
        filtered = filtered.filter((tx) => tx.asset === where.asset);
      }
      return filtered.slice(0, take || 1000);
    },
  },
};

const stellarAdapterMock = {
  getBalances: async (_publicKey) => {
    if (mockStellarShouldFail) {
      throw new Error('Horizon network error');
    }
    return mockStellarBalances;
  },
};

const auditServiceMock = {
  writeAuditLog: async (entry) => {
    mockAuditLogs.push(entry);
    return entry;
  },
};

injectMock('common/prisma', prismaMock);
injectMock('wallet/stellar.adapter', stellarAdapterMock);
injectMock('common/audit.service', auditServiceMock);

const {
  buildStatementData,
  exportStatementCsv,
  exportStatementPdf,
} = require('../src/wallet/statement.service');

describe('wallet/statement.service.js', () => {
  beforeEach(() => {
    mockUsers = {
      'user-123': {
        id: 'user-123',
        phoneNumber: '+2348012345678',
        whatsappName: 'Test Customer',
        kycTier: 'TIER_1',
        wallets: [
          {
            publicKey: 'GABC1234567890STELADDRTEST1234567890123456',
            chain: 'stellar',
            network: 'testnet',
          },
        ],
      },
      'user-no-wallet': {
        id: 'user-no-wallet',
        phoneNumber: '+2348099999999',
        whatsappName: 'No Wallet Customer',
        kycTier: 'TIER_0',
        wallets: [],
      },
    };
    mockTransactions = [];
    mockAuditLogs = [];
    mockStellarBalances = [
      { asset: 'XLM', value: '150.5000000', trusted: true },
      { asset: 'USDC', value: '25.0000000', trusted: true },
    ];
    mockStellarShouldFail = false;
  });

  test('throws 404 error when user account is not found', async () => {
    await assert.rejects(
      async () => {
        await buildStatementData({ userId: 'non-existent-user' });
      },
      (err) => {
        assert.equal(err.message, 'User account not found');
        assert.equal(err.statusCode, 404);
        return true;
      }
    );
  });

  test('builds empty-history statement when user has no transactions', async () => {
    const data = await buildStatementData({ userId: 'user-123' });

    assert.ok(data.statementId.startsWith('STMT-'));
    assert.equal(data.user.id, 'user-123');
    assert.equal(data.user.phoneNumber, '+2348012345678');
    assert.equal(data.wallet.publicKey, 'GABC1234567890STELADDRTEST1234567890123456');
    assert.equal(data.transactionCount, 0);
    assert.deepEqual(data.transactions, []);
    assert.equal(data.totalFeesXlm, '0.0000000');
    assert.deepEqual(data.summary, {});
    assert.equal(data.liveBalances.length, 2);
  });

  test('builds statement with multi-transaction multi-asset history and summaries', async () => {
    mockTransactions = [
      {
        id: 'tx_1',
        userId: 'user-123',
        type: 'send',
        asset: 'XLM',
        amount: '50.0000000',
        status: 'success',
        createdAt: new Date('2026-08-01T10:00:00.000Z'),
        metadata: { fee: '0.0000100', memo: 'Payment for groceries' },
        destination: 'GDEST123',
        txHash: 'hash_111',
        explorerUrl: 'https://stellar.expert/tx/hash_111',
      },
      {
        id: 'tx_2',
        userId: 'user-123',
        type: 'receive',
        asset: 'XLM',
        amount: '100.0000000',
        status: 'success',
        createdAt: new Date('2026-08-05T12:00:00.000Z'),
        metadata: {},
        destination: 'GABC1234567890STELADDRTEST1234567890123456',
        txHash: 'hash_222',
      },
      {
        id: 'tx_3',
        userId: 'user-123',
        type: 'deposit',
        asset: 'USDC',
        amount: '20.0000000',
        status: 'success',
        createdAt: new Date('2026-08-10T14:00:00.000Z'),
        metadata: { fee: '0.0000100' },
        recipientPhoneNumber: '+2348012345678',
      },
    ];

    const data = await buildStatementData({ userId: 'user-123' });

    assert.equal(data.transactionCount, 3);
    assert.equal(data.transactions.length, 3);
    assert.equal(data.totalFeesXlm, '0.0000200');
    assert.equal(data.summary.XLM.sentCount, 1);
    assert.equal(data.summary.XLM.sentAmount, '50.0000000');
    assert.equal(data.summary.XLM.receivedCount, 1);
    assert.equal(data.summary.XLM.receivedAmount, '100.0000000');
    assert.equal(data.summary.USDC.receivedCount, 1);
    assert.equal(data.summary.USDC.receivedAmount, '20.0000000');
    assert.equal(data.transactions[0].id, 'tx_1');
    assert.equal(data.transactions[0].memo, 'Payment for groceries');
  });

  test('filters transactions by date range and specific asset boundaries', async () => {
    mockTransactions = [
      {
        id: 'tx_july',
        userId: 'user-123',
        type: 'send',
        asset: 'XLM',
        amount: '10.0000000',
        createdAt: new Date('2026-07-15T00:00:00.000Z'),
      },
      {
        id: 'tx_august_xlm',
        userId: 'user-123',
        type: 'send',
        asset: 'XLM',
        amount: '20.0000000',
        createdAt: new Date('2026-08-15T00:00:00.000Z'),
      },
      {
        id: 'tx_august_usdc',
        userId: 'user-123',
        type: 'send',
        asset: 'USDC',
        amount: '30.0000000',
        createdAt: new Date('2026-08-20T00:00:00.000Z'),
      },
      {
        id: 'tx_september',
        userId: 'user-123',
        type: 'send',
        asset: 'XLM',
        amount: '40.0000000',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
      },
    ];

    // Filter by August only and XLM asset
    const data = await buildStatementData({
      userId: 'user-123',
      startDate: '2026-08-01T00:00:00.000Z',
      endDate: '2026-08-31T23:59:59.999Z',
      asset: 'XLM',
    });

    assert.equal(data.transactionCount, 1);
    assert.equal(data.transactions[0].id, 'tx_august_xlm');
    assert.equal(data.summary.XLM.sentAmount, '20.0000000');
  });

  test('handles user without wallet and on-chain failure fallback', async () => {
    const dataNoWallet = await buildStatementData({ userId: 'user-no-wallet' });
    assert.equal(dataNoWallet.wallet, null);
    assert.deepEqual(dataNoWallet.liveBalances, []);

    mockStellarShouldFail = true;
    const dataStellarError = await buildStatementData({ userId: 'user-123' });
    assert.equal(dataStellarError.liveBalances.length, 2);
    assert.equal(dataStellarError.liveBalances[0].value, '0');
  });

  test('exportStatementCsv outputs valid CSV and writes audit log', async () => {
    mockTransactions = [
      {
        id: 'tx_1',
        userId: 'user-123',
        type: 'send',
        asset: 'XLM',
        amount: '50.0000000',
        status: 'success',
        createdAt: new Date('2026-08-01T10:00:00.000Z'),
        destination: 'GDEST,WITH"COMMA',
        txHash: 'hash_123',
      },
    ];

    const result = await exportStatementCsv({
      userId: 'user-123',
      actingActor: { type: 'admin', id: 'admin-999' },
      req: { ip: '127.0.0.1' },
    });

    assert.ok(result.csv.includes('# SendAm Account Statement'));
    assert.ok(result.csv.includes('Date,Transaction ID,Type,Asset,Amount,Fee'));
    assert.ok(result.csv.includes('"GDEST,WITH""COMMA"'));
    assert.equal(mockAuditLogs.length, 1);
    assert.equal(mockAuditLogs[0].action, 'wallet.statement.exported');
    assert.equal(mockAuditLogs[0].metadata.format, 'csv');
  });

  test('exportStatementPdf outputs valid PDF-1.4 binary buffer and writes audit log', async () => {
    // Generate over 35 transactions to test truncation note
    mockTransactions = Array.from({ length: 40 }, (_, i) => ({
      id: `tx_${i}`,
      userId: 'user-123',
      type: 'send',
      asset: 'XLM',
      amount: '1.0000000',
      status: 'success',
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
      txHash: `hash_${i}`,
    }));

    const result = await exportStatementPdf({
      userId: 'user-123',
    });

    assert.ok(Buffer.isBuffer(result.pdfBuffer));
    const pdfString = result.pdfBuffer.toString('utf-8');
    assert.ok(pdfString.startsWith('%PDF-1.4'));
    assert.ok(pdfString.includes('%%EOF'));
    assert.ok(pdfString.includes('Account Statement'));
    assert.ok(pdfString.includes('additional transactions truncated'));
    assert.equal(mockAuditLogs.length, 1);
    assert.equal(mockAuditLogs[0].metadata.format, 'pdf');
  });
});
