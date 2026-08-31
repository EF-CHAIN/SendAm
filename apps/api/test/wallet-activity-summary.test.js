const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-admin-password';

const srcRoot = path.resolve(__dirname, '../src');

const injectMock = (relFromSrc, factory) => {
  const abs = path.resolve(srcRoot, `${relFromSrc}.js`);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: factory() };
};

let walletRows = [];
let txRows = [];
let kycRow = null;

injectMock('common/prisma', () => ({
  wallet: {
    findMany: async ({ where }) => {
      if (where.userId) return walletRows.filter((w) => w.userId === where.userId && w.chain === 'stellar');
      return walletRows.filter((w) => w.chain === 'stellar');
    },
  },
  transaction: {
    count: async ({ where }) => {
      let rows = txRows;
      if (where?.userId) rows = rows.filter((t) => t.userId === where.userId);
      if (where?.status) {
        const statuses = Array.isArray(where.status) ? where.status : [where.status];
        rows = rows.filter((t) => statuses.includes(t.status));
      }
      if (where?.createdAt?.gte) {
        rows = rows.filter((t) => new Date(t.createdAt) >= where.createdAt.gte);
      }
      return rows.length;
    },
    aggregate: async ({ where }) => {
      let rows = txRows;
      if (where?.userId) rows = rows.filter((t) => t.userId === where.userId);
      if (where?.status) {
        const statuses = Array.isArray(where.status) ? where.status : [where.status];
        rows = rows.filter((t) => statuses.includes(t.status));
      }
      if (where?.createdAt?.gte) {
        rows = rows.filter((t) => new Date(t.createdAt) >= where.createdAt.gte);
      }
      const sum = rows.reduce((s, t) => s + Number(t.amount), 0).toFixed(2);
      return { _sum: { amount: sum } };
    },
    findMany: async ({ where, orderBy: _orderBy, take }) => {
      let rows = txRows;
      if (where?.userId) rows = rows.filter((t) => t.userId === where.userId);
      if (where?.createdAt?.gte) {
        rows = rows.filter((t) => new Date(t.createdAt) >= where.createdAt.gte);
      }
      return rows.slice(0, take || 20);
    },
  },
  kycProfile: {
    findUnique: async () => kycRow,
  },
  user: {
    findUnique: async ({ where }) => {
      if (where.phoneNumber) return walletRows.find((w) => w.phoneNumber === where.phoneNumber) || null;
      return null;
    },
  },
}));

injectMock('common/audit.service', () => ({ writeAuditLog: async () => {} }));

const { buildWalletSummary } = require('../src/services/wallet-activity-summary.service');

const makeWallet = (overrides = {}) => ({
  id: `wallet-${Date.now()}-${Math.random()}`,
  userId: 'user-1',
  phoneNumber: '+1234567890',
  publicKey: 'GABCDEFG',
  funded: true,
  fundingState: 'succeeded',
  trustlineState: 'succeeded',
  network: 'testnet',
  chain: 'stellar',
  ...overrides,
});

const makeTx = (overrides = {}) => ({
  id: `tx-${Date.now()}-${Math.random()}`,
  userId: 'user-1',
  type: 'send',
  amount: '10.00',
  asset: 'USDC',
  status: 'success',
  destination: 'GDEST',
  explorerUrl: 'https://stellar.expert',
  createdAt: new Date(),
  ...overrides,
});

describe('wallet-activity-summary', () => {
  beforeEach(() => {
    walletRows = [makeWallet()];
    txRows = [makeTx(), makeTx({ status: 'failed' })];
    kycRow = { tier: 1, status: 'approved', riskScore: 10, sanctionsStatus: 'cleared' };
  });

  test('buildWalletSummary returns complete summary', async () => {
    const summary = await buildWalletSummary({ userId: 'user-1', windowDays: 30 });
    assert.strictEqual(summary.wallets.total, 1);
    assert.strictEqual(summary.wallets.funded, 1);
    assert.strictEqual(summary.transactions.total, 2);
    assert.strictEqual(summary.transactions.success, 1);
    assert.strictEqual(summary.transactions.failed, 1);
    assert.ok(summary.kyc);
    assert.strictEqual(summary.kyc.tier, 1);
    assert.strictEqual(summary.recentActivity.length, 2);
  });

  test('buildWalletSummary respects windowDays', async () => {
    txRows = [makeTx({ createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) })];
    const summary = await buildWalletSummary({ userId: 'user-1', windowDays: 30 });
    assert.strictEqual(summary.transactions.total, 0);
    assert.strictEqual(summary.windowDays, 30);
  });

  test('buildWalletSummary handles no KYC profile', async () => {
    kycRow = null;
    const summary = await buildWalletSummary({ userId: 'user-1' });
    assert.strictEqual(summary.kyc, null);
  });

  test('buildWalletSummary caps windowDays at 365', async () => {
    const summary = await buildWalletSummary({ userId: 'user-1', windowDays: 999 });
    assert.ok(summary.windowDays <= 365);
  });
});
