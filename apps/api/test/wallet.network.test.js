const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  || require('node:crypto').randomBytes(32).toString('hex');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/d';

const walletService = require('../src/wallet/wallet.service');
const { WalletNetworkMismatchError, assertUsableOnActiveNetwork, activeNetwork } = walletService;
const config = require('../src/config/env');

const wallet = (overrides = {}) => ({
  id: 'w_1',
  userId: 'u_1',
  chain: 'stellar',
  network: 'testnet',
  networkProvenance: 'verified',
  publicKey: `G${'A'.repeat(55)}`,
  encryptedSecretKey: 'enc',
  ...overrides,
});

test('the active network comes from the resolved config profile', () => {
  assert.equal(activeNetwork(), config.stellar.network);
  assert.equal(activeNetwork(), 'testnet');
});

test('a wallet on the active network is accepted', () => {
  const w = wallet();
  assert.equal(assertUsableOnActiveNetwork(w), w);
});

test('a wallet from another network is refused', () => {
  assert.throws(
    () => assertUsableOnActiveNetwork(wallet({ network: 'public' })),
    (error) => {
      assert.ok(error instanceof WalletNetworkMismatchError);
      assert.equal(error.code, 'WALLET_NETWORK_MISMATCH');
      assert.match(error.message, /belongs to network 'public'/);
      return true;
    },
  );
});

test('a null wallet passes through rather than throwing', () => {
  assert.equal(assertUsableOnActiveNetwork(null), null);
});

test('unverified provenance is tolerated on testnet', () => {
  // On testnet the blast radius is nil, so legacy rows stay usable.
  const w = wallet({ networkProvenance: 'assumed' });
  assert.equal(assertUsableOnActiveNetwork(w), w);
});

test('unverified provenance is refused for a mainnet operation', (t) => {
  const original = { network: config.stellar.network, isMainnet: config.stellar.isMainnet };
  config.stellar.network = 'public';
  config.stellar.isMainnet = true;
  t.after(() => Object.assign(config.stellar, original));

  assert.throws(
    () => assertUsableOnActiveNetwork(wallet({ network: 'public', networkProvenance: 'assumed' })),
    /unverified network provenance/,
  );

  // A verified mainnet wallet is fine.
  const verified = wallet({ network: 'public', networkProvenance: 'verified' });
  assert.equal(assertUsableOnActiveNetwork(verified), verified);
});

test('quarantined rows are refused on mainnet', (t) => {
  const original = { network: config.stellar.network, isMainnet: config.stellar.isMainnet };
  config.stellar.network = 'public';
  config.stellar.isMainnet = true;
  t.after(() => Object.assign(config.stellar, original));

  assert.throws(
    () => assertUsableOnActiveNetwork(wallet({ network: 'public', networkProvenance: 'quarantined' })),
    /unverified network provenance/,
  );
});

test('submitPayment refuses wallet material from another network before decrypting', async () => {
  // If the guard did not fire, decrypt() would be reached and throw a
  // different error — so the assertion below also proves ordering.
  await assert.rejects(
    () => walletService.submitPayment({
      wallet: wallet({ network: 'public' }),
      destination: `G${'B'.repeat(55)}`,
      amount: '1',
      asset: 'XLM',
    }),
    /belongs to network 'public'/,
  );
});

test('network is part of the wallet identity constraint in the schema', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../prisma/schema.prisma'), 'utf8');
  const walletModel = schema.slice(schema.indexOf('model Wallet {'));
  const body = walletModel.slice(0, walletModel.indexOf('\n}'));

  assert.match(body, /@@unique\(\[userId, chain, network\]\)/);
  assert.doesNotMatch(body, /@@unique\(\[userId, chain\]\)/);
  assert.match(body, /networkProvenance\s+String/);
});

test('the migration quarantines rather than trusting or deleting legacy rows', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '../prisma/migrations/20260829160000_wallet_network_identity/migration.sql'),
    'utf8',
  );

  // Pre-existing rows inherited the column default; none may be assumed correct.
  assert.match(sql, /UPDATE "Wallet" SET "networkProvenance" = 'assumed'/);
  // Rows on an unsupported network are quarantined, not dropped.
  assert.match(sql, /networkProvenance" = 'quarantined'/);
  assert.doesNotMatch(sql, /DELETE FROM "Wallet"/);
  // Identity is replaced, not merely supplemented.
  assert.match(sql, /DROP INDEX IF EXISTS "Wallet_userId_chain_key"/);
  assert.match(sql, /CREATE UNIQUE INDEX "Wallet_userId_chain_network_key"/);
  // Historical spellings are normalised so the constraint cannot be defeated.
  assert.match(sql, /'pubnet', 'mainnet'/);
});

test('no wallet lookup still uses the network-blind compound key', () => {
  const srcDir = path.join(__dirname, '../src');
  const offenders = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const text = fs.readFileSync(full, 'utf8');
        // `userId_chain` not followed by `_network` is the old, unscoped key.
        if (/userId_chain(?!_network)/.test(text)) offenders.push(path.relative(srcDir, full));
      }
    }
  };
  walk(srcDir);

  assert.deepEqual(offenders, []);
});
