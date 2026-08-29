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
let keySequence = 0;
const fakeAdapter = {
  createWallet: () => { keySequence += 1; return { publicKey: `GNEW${keySequence}`, secretKey: `SNEW${keySequence}` }; },
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
let storedWallet;
let returnExisting = false;
let userUpserts = 0;
const fakePrisma = {
  wallet: {
    findUnique: async ({ where }) => where.id ? storedWallet : (returnExisting ? storedWallet : null),
    create: async (a) => {
      if (storedWallet) { returnExisting = true; throw Object.assign(new Error('unique constraint'), { code: 'P2002' }); }
      storedWallet = { id: 1, funded: false, fundingState: 'pending', fundingAttempts: 0, trustlineState: 'pending', trustlineAttempts: 0, ...a.data };
      return storedWallet;
    },
    updateMany: async ({ where, data }) => {
      const stateField = where.OR?.[0]?.fundingState ? 'fundingState' : 'trustlineState';
      const allowed = where.OR?.[0]?.[stateField]?.in || [];
      if (!allowed.includes(storedWallet[stateField])) return { count: 0 };
      storedWallet = { ...storedWallet, ...data, fundingAttempts: data.fundingAttempts ? storedWallet.fundingAttempts + 1 : storedWallet.fundingAttempts, trustlineAttempts: data.trustlineAttempts ? storedWallet.trustlineAttempts + 1 : storedWallet.trustlineAttempts };
      return { count: 1 };
    },
    update: async (a) => { storedWallet = { ...storedWallet, ...a.data }; return storedWallet; },
  },
  user: { upsert: async (a) => { userUpserts += 1; return { id: 10, ...a.create }; } },
};
injectMock('common/prisma', () => fakePrisma);

injectMock('common/records', () => ({
  withIdAlias: (x) => x,
  withIdAliases: (xs) => xs,
}));
injectMock('utils/validators', () => ({ canonicalizePhoneNumber: (value) => value }));

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
  fundingState: 'pending',
  trustlineState: 'pending',
  ...overrides,
});

// Reset per-test state and restore default adapter behaviour.
beforeEach(() => {
  calls.fund = [];
  calls.trustline = [];
  keySequence = 0;
  storedWallet = null;
  returnExisting = false;
  userUpserts = 0;
  fakeAdapter.fundTestnetAccount = async (publicKey) => {
    calls.fund.push(publicKey);
    return { funded: true };
  };
  fakeAdapter.establishTrustline = async (args) => {
    calls.trustline.push(args);
    return { established: true, alreadyExisted: false };
  };
});

// ─── createOrGetWallet ──────────────────────────────────────────────────────

describe('walletService.createOrGetWallet', () => {
  test('concurrent requests recover the unique race and return one durable key', async () => {
    let releaseFunding;
    fakeAdapter.fundTestnetAccount = async (publicKey) => {
      calls.fund.push(publicKey);
      await new Promise((resolve) => { releaseFunding = resolve; });
      return { funded: true };
    };
    const first = walletService.createOrGetWallet({ phoneNumber: '+1234567890' });
    await new Promise((resolve) => setImmediate(resolve));
    const second = walletService.createOrGetWallet({ phoneNumber: '+1234567890' });
    await new Promise((resolve) => setImmediate(resolve));
    releaseFunding();
    const [left, right] = await Promise.all([first, second]);
    assert.equal(left.id, right.id);
    assert.equal(left.publicKey, right.publicKey);
    assert.equal(storedWallet.encryptedSecretKey, 'enc(SNEW1)');
    assert.equal(calls.fund.length, 1);
    assert.equal(userUpserts, 2);
  });

  test('opens the USDC trustline for a newly funded wallet', async () => {
    const wallet = await walletService.createOrGetWallet({ user: { id: 10, phoneNumber: '+1234567890' } });

    assert.equal(wallet.funded, true);
    assert.deepEqual(calls.fund, ['GNEW1']);
    assert.equal(calls.trustline.length, 1);
    assert.deepEqual(calls.trustline[0], { secretKey: 'SNEW1', assetCode: 'USDC' });
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

  test('a later create-or-get retries persisted provider failure state', async () => {
    let attempts = 0;
    fakeAdapter.fundTestnetAccount = async (publicKey) => {
      calls.fund.push(publicKey); attempts += 1;
      if (attempts === 1) throw new Error('provider unavailable');
      return { funded: true };
    };
    const first = await walletService.createOrGetWallet({ user: { id: 10, phoneNumber: '+1234567890' } });
    assert.equal(first.fundingState, 'failed');
    returnExisting = true;
    const recovered = await walletService.createOrGetWallet({ user: { id: 10, phoneNumber: '+1234567890' } });
    assert.equal(recovered.fundingState, 'succeeded');
    assert.equal(recovered.trustlineState, 'succeeded');
    assert.equal(calls.fund.length, 2);
  });

  test('returns the existing wallet without re-funding or re-trusting', async () => {
    storedWallet = makeWallet({ funded: true, fundingState: 'succeeded', trustlineState: 'succeeded' });
    returnExisting = true;

    await walletService.createOrGetWallet({ user: { id: 10, phoneNumber: '+1234567890' } });

    assert.equal(calls.fund.length, 0);
    assert.equal(calls.trustline.length, 0);
  });
});

// ─── fundWallet ─────────────────────────────────────────────────────────────

describe('walletService.fundWallet', () => {
  test('retries the USDC trustline for an existing wallet', async () => {
    storedWallet = makeWallet();
    const { wallet, result } = await walletService.fundWallet({ wallet: storedWallet });

    assert.equal(result.funded, true);
    assert.equal(wallet.funded, true);
    assert.deepEqual(calls.fund, ['GABCDEFG']);
    assert.equal(calls.trustline.length, 1);
    // secretKey comes from decrypting the stored encryptedSecretKey.
    assert.deepEqual(calls.trustline[0], { secretKey: 'secret', assetCode: 'USDC' });
  });

  test('does not retry the trustline when funding did not succeed', async () => {
    storedWallet = makeWallet();
    fakeAdapter.fundTestnetAccount = async (publicKey) => {
      calls.fund.push(publicKey);
      return { funded: false };
    };

    await walletService.fundWallet({ wallet: storedWallet });

    assert.equal(calls.trustline.length, 0);
  });
});
