// Tests for issue #26: multi-asset balance reply.
//
// Covers:
//   1. walletService.balancesForUser — per-asset rows via mocked adapter
//   2. replies.balances             — multi-asset reply rendering
//
// Uses Node's built-in test runner (node:test).
// Prisma and the Stellar adapter are injected via require.cache so no live
// DB connection or Horizon calls are made.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Prevent validateEnv startup errors.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-admin-password';

// ─── require.cache injection helpers ────────────────────────────────────────

const srcRoot = path.resolve(__dirname, '../src');

// Inject a synthetic module into require.cache so the SUT loads the fake
// instead of the real implementation. Must be called BEFORE the SUT is loaded.
const injectMock = (relFromSrc, factory) => {
  const abs = path.resolve(srcRoot, `${relFromSrc}.js`);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: factory() };
};

// ─── set up mocks before loading the SUT ───────────────────────────────────

// Stub out crypto.service so wallet.service can load without a real key store.
injectMock('services/crypto.service', () => ({
  encrypt: (s) => `enc(${s})`,
  decrypt: (s) => s.replace(/^enc\(|\)$/g, ''),
}));

// Stub out audit.service.
injectMock('common/audit.service', () => ({ writeAuditLog: async () => {} }));

// Stub out logger.
injectMock('utils/logger', () => ({
  info: () => {},
  warn: () => {},
  error: () => {},
}));

// Stub out stellar.adapter — we'll replace getBalances per test.
const fakeAdapter = {
  getBalance: async () => '0',
  getBalances: async () => [{ asset: 'XLM', value: '0' }],
  createWallet: () => ({ publicKey: 'GFAKE', secretKey: 'SFAKE' }),
  validateAddress: () => true,
  fundTestnetAccount: async () => ({ funded: true }),
};
injectMock('wallet/stellar.adapter', () => fakeAdapter);

// Stub out prisma — we'll replace wallet.findMany per test.
const fakePrisma = {
  wallet: { findMany: async () => [], findUnique: async () => null, create: async (a) => a.data, update: async (a) => a.data },
  user:   { findUnique: async () => null, create: async (a) => ({ id: 1, ...a.data }) },
};
injectMock('common/prisma', () => fakePrisma);

// Also stub common/records which wallet.service imports.
injectMock('common/records', () => ({
  withIdAlias:   (x) => x,
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
  funded: true,
  ...overrides,
});

// ─── 1. walletService.balancesForUser ───────────────────────────────────────

describe('walletService.balancesForUser', () => {
  test('returns per-asset rows for XLM + USDC when both trustlines exist', async () => {
    fakePrisma.wallet.findMany = async () => [makeWallet()];
    fakeAdapter.getBalances = async () => [
      { asset: 'XLM', value: '340.0000000' },
      { asset: 'USDC', value: '20.0000000' },
    ];

    const result = await walletService.balancesForUser({ userId: 10 });

    assert.equal(result.length, 1);
    assert.deepEqual(result[0].assets, [
      { asset: 'XLM', value: '340.0000000' },
      { asset: 'USDC', value: '20.0000000' },
    ]);
    assert.equal(result[0].error, undefined);
  });

  test('returns only XLM row when account has no USDC trustline', async () => {
    fakePrisma.wallet.findMany = async () => [makeWallet()];
    fakeAdapter.getBalances = async () => [{ asset: 'XLM', value: '5.0000000' }];

    const result = await walletService.balancesForUser({ userId: 10 });

    assert.equal(result.length, 1);
    assert.deepEqual(result[0].assets, [{ asset: 'XLM', value: '5.0000000' }]);
    assert.equal(result[0].error, undefined);
  });

  test('isolates a Horizon failure — errored wallet has empty assets + error, healthy wallet renders normally', async () => {
    fakePrisma.wallet.findMany = async () => [
      makeWallet({ id: 1, publicKey: 'GAAA' }),
      makeWallet({ id: 2, publicKey: 'GBBB' }),
    ];

    let call = 0;
    fakeAdapter.getBalances = async () => {
      call += 1;
      if (call === 1) throw new Error('Horizon timeout');
      return [{ asset: 'XLM', value: '99.0000000' }];
    };

    const result = await walletService.balancesForUser({ userId: 10 });
    call = 0; // reset for next test

    assert.equal(result.length, 2);

    // First wallet: Horizon failed.
    assert.deepEqual(result[0].assets, []);
    assert.equal(typeof result[0].error, 'string');
    assert.match(result[0].error, /Horizon timeout/);

    // Second wallet: ok.
    assert.deepEqual(result[1].assets, [{ asset: 'XLM', value: '99.0000000' }]);
    assert.equal(result[1].error, undefined);
  });

  test('looks up wallets by phoneNumber when userId is not provided', async () => {
    const calls = [];
    fakePrisma.wallet.findMany = async (args) => {
      calls.push(args);
      return [makeWallet()];
    };
    fakeAdapter.getBalances = async () => [{ asset: 'XLM', value: '1.0000000' }];

    await walletService.balancesForUser({ phoneNumber: '+1234567890' });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].where, { phoneNumber: '+1234567890', chain: 'stellar' });
  });
});

// ─── 2. replies.balances ────────────────────────────────────────────────────

describe('replies.balances', () => {
  const { replies } = require('../src/services/agent/replies');

  test('renders XLM and USDC on separate lines', () => {
    const wallets = [
      {
        chain: 'stellar',
        address: 'GABCD',
        assets: [
          { asset: 'XLM', value: '340.0000000' },
          { asset: 'USDC', value: '20.0000000' },
        ],
      },
    ];

    const reply = replies.balances(wallets);
    assert.match(reply, /XLM: 340\.0000000/);
    assert.match(reply, /USDC: 20\.0000000/);

    // Each asset must appear on its own line.
    const lines = reply.split('\n').filter((l) => l.trim());
    const xlmLine = lines.find((l) => l.startsWith('XLM:'));
    const usdcLine = lines.find((l) => l.startsWith('USDC:'));
    assert.ok(xlmLine, 'XLM line missing');
    assert.ok(usdcLine, 'USDC line missing');
    assert.notEqual(xlmLine, usdcLine);
  });

  test('renders only XLM for an account with no USDC trustline — no fake zero row', () => {
    const wallets = [
      {
        chain: 'stellar',
        address: 'GABCD',
        assets: [{ asset: 'XLM', value: '5.0000000' }],
      },
    ];

    const reply = replies.balances(wallets);
    assert.match(reply, /XLM: 5\.0000000/);
    assert.doesNotMatch(reply, /USDC/);
  });

  test('shows error line for a failed wallet and still renders the healthy one', () => {
    const wallets = [
      { chain: 'stellar', address: 'GAAA', assets: [], error: 'Horizon timeout' },
      { chain: 'stellar', address: 'GBBB', assets: [{ asset: 'XLM', value: '99.0000000' }] },
    ];

    const reply = replies.balances(wallets);
    assert.match(reply, /unavailable.*Horizon timeout/i);
    assert.match(reply, /XLM: 99\.0000000/);
  });

  test('handles multiple wallets each with their own asset rows', () => {
    const wallets = [
      {
        chain: 'stellar',
        address: 'GAAA',
        assets: [
          { asset: 'XLM', value: '10.0000000' },
          { asset: 'USDC', value: '50.0000000' },
        ],
      },
      {
        chain: 'stellar',
        address: 'GBBB',
        assets: [{ asset: 'XLM', value: '200.0000000' }],
      },
    ];

    const reply = replies.balances(wallets);
    const assetLines = reply.split('\n').filter((l) => /^[A-Z]+:/.test(l));
    // 2 from first wallet + 1 from second = 3 total asset lines
    assert.equal(assetLines.length, 3, `Expected 3 asset lines, got: ${assetLines.join(' | ')}`);
  });
});
