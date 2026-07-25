// Tests for issue #25: open the USDC trustline at wallet creation.
//
// Covers walletService.createOrGetWallet and fundWallet:
//   1. success path — a funded new wallet opens the USDC trustline
//   2. trustline-failure path — a failure is non-fatal, wallet still created
//   3. retry path — fundWallet retries the trustline for an existing wallet
//
// Uses Node's built-in test runner (node:test). Prisma and the Stellar adapter
// are injected via require.cache so no live DB connection or Horizon calls are
// made — same convention as balance.multiasset.test.js.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Prevent validateEnv startup errors.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-admin-password';

// ─── require.cache injection helpers ────────────────────────────────────────

const srcRoot = path.resolve(__dirname, '../src');

const injectMock = (relFromSrc, factory) => {
  const abs = path.resolve(srcRoot, `${relFromSrc}.js`);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: factory() };
};

// ─── set up mocks before loading the SUT ───────────────────────────────────

injectMock('services/crypto.service', () => ({
  encrypt: (s) => `enc(${s})`,
  decrypt: (s) => s.replace(/^enc\(|\)$/g, ''),
}));

injectMock('common/audit.service', () => ({ writeAuditLog: async () => {} }));

injectMock('utils/logger', () => ({
  info: () => {},
  warn: () => {},
  error: () => {},
}));

// Stub the Stellar adapter. Tests replace fundTestnetAccount / establishTrustline
// per case, and every call is recorded on `calls` for assertions.
const calls = { fund: [], trustline: [] };
const fakeAdapter = {
  createWallet: () => ({ publicKey: 'GNEW', secretKey: 'SNEW' }),
  fundTestnetAccount: async (publicKey) => {
    calls.fund.push(publicKey);
    return { funded: true };
  },
  establishTrustline: async (args) => {
    calls.trustline.push(args);
    return { established: true, alreadyExisted: false };
  },
};
injectMock('wallet/stellar.adapter', () => fakeAdapter);

// Stub prisma. Wallet updates echo back the merged row so callers see `funded`.
const fakePrisma = {
  wallet: {
    findUnique: async () => null,
    create: async (a) => ({ id: 1, ...a.data }),
    update: async (a) => ({ id: a.where.id, ...a.data }),
  },
  user: { findUnique: async () => null, create: async (a) => ({ id: 10, ...a.data }) },
};
injectMock('common/prisma', () => fakePrisma);

injectMock('common/records', () => ({
  withIdAlias: (x) => x,
  withIdAliases: (xs) => xs,
}));

// Now load the SUT.
const walletService = require('../src/wallet/wallet.service');

// ─── helpers ────────────────────────────────────────────────────────────────

const makeWallet = (overrides = {}) => ({
  id: 1,
  userId: 10,
  chain: 'stellar',
  phoneNumber: '+1234567890',
  publicKey: 'GABCDEFG',
  encryptedSecretKey: 'enc(secret)',
  funded: false,
  ...overrides,
});

// Reset per-test state and restore default adapter behaviour.
beforeEach(() => {
  calls.fund = [];
  calls.trustline = [];
  fakeAdapter.fundTestnetAccount = async (publicKey) => {
    calls.fund.push(publicKey);
    return { funded: true };
  };
  fakeAdapter.establishTrustline = async (args) => {
    calls.trustline.push(args);
    return { established: true, alreadyExisted: false };
  };
  fakePrisma.wallet.findUnique = async () => null;
});

// ─── createOrGetWallet ──────────────────────────────────────────────────────

describe('walletService.createOrGetWallet', () => {
  test('opens the USDC trustline for a newly funded wallet', async () => {
    const wallet = await walletService.createOrGetWallet({ user: { id: 10, phoneNumber: '+1234567890' } });

    assert.equal(wallet.funded, true);
    assert.deepEqual(calls.fund, ['GNEW']);
    assert.equal(calls.trustline.length, 1);
    assert.deepEqual(calls.trustline[0], { secretKey: 'SNEW', assetCode: 'USDC' });
  });

  test('trustline failure is non-fatal — the wallet is still created', async () => {
    fakeAdapter.establishTrustline = async (args) => {
      calls.trustline.push(args);
      throw new Error('Account is not funded yet — fund it before opening a trustline.');
    };

    const wallet = await walletService.createOrGetWallet({ user: { id: 10, phoneNumber: '+1234567890' } });

    assert.ok(wallet, 'wallet should still be returned');
    assert.equal(wallet.funded, true);
    assert.equal(calls.trustline.length, 1);
  });

  test('does not attempt a trustline when funding fails', async () => {
    fakeAdapter.fundTestnetAccount = async () => {
      throw new Error('Failed to fund account on Testnet');
    };

    const wallet = await walletService.createOrGetWallet({ user: { id: 10, phoneNumber: '+1234567890' } });

    assert.ok(wallet, 'wallet should still be returned despite funding failure');
    assert.equal(calls.trustline.length, 0);
  });

  test('returns the existing wallet without re-funding or re-trusting', async () => {
    fakePrisma.wallet.findUnique = async () => makeWallet({ funded: true });

    await walletService.createOrGetWallet({ user: { id: 10, phoneNumber: '+1234567890' } });

    assert.equal(calls.fund.length, 0);
    assert.equal(calls.trustline.length, 0);
  });
});

// ─── fundWallet ─────────────────────────────────────────────────────────────

describe('walletService.fundWallet', () => {
  test('retries the USDC trustline for an existing wallet', async () => {
    const { wallet, result } = await walletService.fundWallet({ wallet: makeWallet() });

    assert.equal(result.funded, true);
    assert.equal(wallet.funded, true);
    assert.deepEqual(calls.fund, ['GABCDEFG']);
    assert.equal(calls.trustline.length, 1);
    // secretKey comes from decrypting the stored encryptedSecretKey.
    assert.deepEqual(calls.trustline[0], { secretKey: 'secret', assetCode: 'USDC' });
  });

  test('does not retry the trustline when funding did not succeed', async () => {
    fakeAdapter.fundTestnetAccount = async (publicKey) => {
      calls.fund.push(publicKey);
      return { funded: false };
    };

    await walletService.fundWallet({ wallet: makeWallet() });

    assert.equal(calls.trustline.length, 0);
  });
});
