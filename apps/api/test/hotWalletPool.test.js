'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const StellarSdk = require('@stellar/stellar-sdk');

const {
  HotWalletPool,
  BalanceCapExceededError,
} = require('../src/wallet/hotWalletPool');

const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;

test('HotWalletPool - initialization and balance cap enforcement', () => {
  const coldSigner1 = StellarSdk.Keypair.random();
  const coldSigner2 = StellarSdk.Keypair.random();
  const coldSigner3 = StellarSdk.Keypair.random();

  const pool = new HotWalletPool({
    coldStoragePublicKey: coldSigner1.publicKey(),
    coldStorageSigners: [coldSigner1, coldSigner2, coldSigner3],
    coldStorageThreshold: 2,
    poolSize: 3,
    maxBalanceXlm: 500.0,
    targetReplenishXlm: 200.0,
  });

  const status = pool.getStatus();
  assert.equal(status.poolSize, 3);
  assert.equal(status.maxBalanceCapXlm, 500.0);
  assert.equal(status.activeWallets.length, 3);

  // Every wallet must strictly adhere to the < 500 XLM cap
  for (const wallet of status.activeWallets) {
    assert.ok(wallet.balanceXlm <= 500.0, `Wallet balance ${wallet.balanceXlm} must be <= 500 XLM`);
    assert.equal(wallet.balanceXlm, 200.0);
  }

  // Reject initializing a wallet that exceeds the max balance cap
  assert.throws(
    () => {
      new HotWalletPool({
        coldStoragePublicKey: coldSigner1.publicKey(),
        coldStorageSigners: [coldSigner1, coldSigner2],
        maxBalanceXlm: 500.0,
        initialWallets: [
          { secret: StellarSdk.Keypair.random().secret(), balanceXlm: 550.0 },
        ],
      });
    },
    BalanceCapExceededError
  );
});

test('HotWalletPool - automated alert on low liquidity', async () => {
  const coldSigner1 = StellarSdk.Keypair.random();
  const coldSigner2 = StellarSdk.Keypair.random();

  const alerts = [];
  const pool = new HotWalletPool({
    coldStoragePublicKey: coldSigner1.publicKey(),
    coldStorageSigners: [coldSigner1, coldSigner2],
    minBalanceXlm: 50.0,
    targetReplenishXlm: 150.0,
    onAlert: (alert) => alerts.push(alert),
    initialWallets: [
      { secret: StellarSdk.Keypair.random().secret(), balanceXlm: 100.0 },
    ],
  });

  // Acquire the wallet
  const leased = await pool.acquireWallet({ minAmountXlm: 60.0 });
  assert.equal(leased.balanceXlm, 100.0);

  // Release with 60 XLM deducted, leaving 40 XLM (< 50 XLM safety threshold)
  await pool.releaseWallet(leased.id, { amountDeductedXlm: 60.0 });

  // Verify that an automated low-liquidity alert fired!
  const lowLiquidityAlert = alerts.find((a) => a.type === 'low_liquidity');
  assert.ok(lowLiquidityAlert, 'Low liquidity alert must fire when balance drops below 50 XLM');
  assert.equal(lowLiquidityAlert.payload.walletId, leased.id);
  assert.equal(lowLiquidityAlert.payload.thresholdXlm, 50.0);

  // Verify automated replenishment brought it back to target
  const status = pool.getStatus();
  const wallet = status.activeWallets.find((w) => w.id === leased.id);
  assert.equal(wallet.balanceXlm, 150.0);
  assert.ok(status.replenishmentsCount >= 1);
});

test('HotWalletPool - multi-sig replenishment from cold storage (2-of-3 threshold)', async () => {
  const coldSigner1 = StellarSdk.Keypair.random();
  const coldSigner2 = StellarSdk.Keypair.random();
  const coldSigner3 = StellarSdk.Keypair.random();

  let submittedTransaction = null;
  const mockServer = {
    loadAccount: async (publicKey) => {
      const acc = new StellarSdk.Account(publicKey, '1000');
      acc.balances = [{ asset_type: 'native', balance: '10000.0000000' }];
      return acc;
    },
    submitTransaction: async (tx) => {
      submittedTransaction = tx;
      return { hash: tx.hash().toString('hex') };
    },
  };

  const pool = new HotWalletPool({
    coldStoragePublicKey: coldSigner1.publicKey(),
    coldStorageSigners: [coldSigner1, coldSigner2, coldSigner3],
    coldStorageThreshold: 2,
    server: mockServer,
    networkPassphrase: NETWORK_PASSPHRASE,
    minBalanceXlm: 50.0,
    targetReplenishXlm: 250.0,
    maxBalanceXlm: 500.0,
    initialWallets: [
      { secret: StellarSdk.Keypair.random().secret(), balanceXlm: 20.0 }, // Starts below 50 XLM
    ],
  });

  const statusBefore = pool.getStatus();
  const walletId = statusBefore.activeWallets[0].id;

  // Replenish wallet
  const result = await pool.replenishWallet(walletId);
  assert.equal(result.replenished, true);
  assert.equal(result.amountXlm, 230.0); // 20 + 230 = 250
  assert.equal(result.newBalanceXlm, 250.0);

  // Assert multi-sig transaction was submitted with at least 2 signatures
  assert.ok(submittedTransaction, 'Transaction must have been submitted to server');
  assert.ok(submittedTransaction.signatures.length >= 2, 'Must have at least 2 signatures for 2-of-3 quorum');

  // Verify capped at maxBalanceXlm
  assert.ok(result.newBalanceXlm <= 500.0, 'Balance must remain <= 500 XLM');
});

test('HotWalletPool - rotation of ephemeral hot wallets', async () => {
  const coldSigner1 = StellarSdk.Keypair.random();
  const coldSigner2 = StellarSdk.Keypair.random();

  const pool = new HotWalletPool({
    coldStoragePublicKey: coldSigner1.publicKey(),
    coldStorageSigners: [coldSigner1, coldSigner2],
    poolSize: 2,
    targetReplenishXlm: 100.0,
  });

  const initialStatus = pool.getStatus();
  const walletToRotate = initialStatus.activeWallets[0];

  const rotated = await pool.rotateWallet(walletToRotate.id);
  assert.notEqual(rotated.id, walletToRotate.id);
  assert.notEqual(rotated.publicKey, walletToRotate.publicKey);
  assert.equal(rotated.balanceXlm, 100.0);

  const updatedStatus = pool.getStatus();
  assert.equal(updatedStatus.activeWallets.length, 2);
  const foundOld = updatedStatus.activeWallets.find((w) => w.id === walletToRotate.id);
  assert.equal(foundOld, undefined, 'Retired wallet must not be in active wallets');
});

test('HotWalletPool - checkPoolHealth triggers alerts and replenishes low wallets', async () => {
  const coldSigner1 = StellarSdk.Keypair.random();
  const coldSigner2 = StellarSdk.Keypair.random();

  const alerts = [];
  const pool = new HotWalletPool({
    coldStoragePublicKey: coldSigner1.publicKey(),
    coldStorageSigners: [coldSigner1, coldSigner2],
    minBalanceXlm: 50.0,
    targetReplenishXlm: 200.0,
    onAlert: (alert) => alerts.push(alert),
    initialWallets: [
      { secret: StellarSdk.Keypair.random().secret(), balanceXlm: 30.0 }, // low
      { secret: StellarSdk.Keypair.random().secret(), balanceXlm: 150.0 }, // healthy
      { secret: StellarSdk.Keypair.random().secret(), balanceXlm: 10.0 }, // low
    ],
  });

  const health = await pool.checkPoolHealth();
  assert.equal(health.totalWallets, 3);
  assert.equal(health.lowLiquidityWallets.length, 2);
  assert.equal(health.replenishedCount, 2);

  // Check alerts fired for each low wallet
  const lowAlerts = alerts.filter((a) => a.type === 'low_liquidity');
  assert.equal(lowAlerts.length, 2);

  // Check all wallets now healthy
  const status = pool.getStatus();
  for (const w of status.activeWallets) {
    assert.ok(w.balanceXlm >= 50.0, 'All wallets should now have balance >= 50 XLM');
    assert.ok(w.balanceXlm <= 500.0, 'All wallets must remain <= 500 XLM');
  }
});
