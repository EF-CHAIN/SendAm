const { test } = require('node:test');
const assert = require('node:assert/strict');
const StellarSdk = require('@stellar/stellar-sdk');

const {
  FeeBumpManager,
  FeeBumpExhaustedError,
  FeeBumpCapExceededError,
  buildFeeBumpEnvelope,
  computeBoostedFee,
  unwrapInnerTransaction,
} = require('../src/wallet/feeBump');

const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;

const buildSignedPaymentTx = ({ fee = '100', seq = '100' } = {}) => {
  const sourceKeypair = StellarSdk.Keypair.random();
  const destination = StellarSdk.Keypair.random().publicKey();
  const account = new StellarSdk.Account(sourceKeypair.publicKey(), seq);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination,
        asset: StellarSdk.Asset.native(),
        amount: '10.0000000',
      }),
    )
    .setTimeout(60)
    .build();
  tx.sign(sourceKeypair);
  return { tx, sourceKeypair, destination };
};

test('buildFeeBumpEnvelope wraps inner transaction in SEP-0015 FeeBumpTransaction and unwraps nested fee bumps', () => {
  const { tx } = buildSignedPaymentTx({ fee: '100' });
  const feeSource = StellarSdk.Keypair.random();

  const bump1 = buildFeeBumpEnvelope({
    innerTransaction: tx,
    feeSourceKeypair: feeSource,
    maxFeeStroops: 500,
    networkPassphrase: NETWORK_PASSPHRASE,
  });

  assert.ok(bump1 instanceof StellarSdk.FeeBumpTransaction);
  assert.equal(bump1.feeSource, feeSource.publicKey());
  assert.equal(bump1.fee, '500');
  assert.equal(bump1.innerTransaction.hash().toString('hex'), tx.hash().toString('hex'));
  assert.equal(bump1.signatures.length, 1);

  // Passing a FeeBumpTransaction unwraps to the original inner tx (no invalid nesting).
  const bump2 = buildFeeBumpEnvelope({
    innerTransaction: bump1,
    feeSourceKeypair: feeSource,
    maxFeeStroops: 1200,
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  assert.equal(unwrapInnerTransaction(bump2).hash().toString('hex'), tx.hash().toString('hex'));
  assert.equal(bump2.fee, '1200');
});

test('submitWithFeeBump returns immediately when initial transaction confirms without congestion', async () => {
  const { tx } = buildSignedPaymentTx({ fee: '100' });
  const feeSource = StellarSdk.Keypair.random();
  const innerHash = tx.hash().toString('hex');

  const manager = new FeeBumpManager({
    networkPassphrase: NETWORK_PASSPHRASE,
    server: {
      submitTransaction: async () => ({ hash: innerHash, ledger: 1001, successful: true }),
    },
  });

  const result = await manager.submitWithFeeBump({
    transaction: tx,
    feeSourceKeypair: feeSource,
  });

  assert.equal(result.status, 'confirmed');
  assert.equal(result.txHash, innerHash);
  assert.equal(result.bumpCount, 0);
  assert.equal(result.finalFeeStroops, 100);
});

test('automatically rebroadcasts stalled transaction with boosted SEP-0015 fee after 3 ledgers', async () => {
  const { tx } = buildSignedPaymentTx({ fee: '100' });
  const feeSource = StellarSdk.Keypair.random();
  const innerHash = tx.hash().toString('hex');

  let currentLedger = 5000;
  const submittedEnvelopes = [];
  const bumpEvents = [];

  const mockServer = {
    feeStats: async () => ({
      last_ledger_base_fee: '300',
      fee_charged: { p90: '400' },
      max_fee: { p80: '500' },
    }),
    ledgers: () => ({
      order: () => ({
        limit: () => ({
          call: async () => ({ records: [{ sequence: currentLedger }] }),
        }),
      }),
    }),
    transactions: () => ({
      transaction: () => ({
        call: async () => {
          const err = new Error('Not Found');
          err.response = { status: 404 };
          throw err;
        },
      }),
    }),
    submitTransaction: async (envelope) => {
      submittedEnvelopes.push(envelope);
      if (submittedEnvelopes.length === 1) {
        // Initial submission times out (504) during congestion.
        const err = new Error('Gateway Timeout 504');
        err.response = { status: 504 };
        throw err;
      }
      // Second submission (SEP-0015 FeeBumpTransaction) confirms on-chain!
      return {
        hash: envelope.hash().toString('hex'),
        ledger: currentLedger + 1,
        successful: true,
      };
    },
  };

  const manager = new FeeBumpManager({
    server: mockServer,
    networkPassphrase: NETWORK_PASSPHRASE,
    stalledLedgerThreshold: 3,
    pollIntervalMs: 1,
    sleep: async () => {
      // Simulate 1 ledger closing per poll interval.
      currentLedger += 1;
    },
    onBump: (evt) => bumpEvents.push(evt),
  });

  const result = await manager.submitWithFeeBump({
    transaction: tx,
    feeSourceKeypair: feeSource,
  });

  assert.equal(result.status, 'confirmed');
  assert.equal(result.bumpCount, 1);
  assert.equal(result.innerHash, innerHash);
  assert.ok(result.feeBumpHash && result.feeBumpHash !== innerHash);
  assert.ok(result.finalFeeStroops > 100);
  assert.equal(bumpEvents.length, 1);

  // Verify the second envelope is a FeeBumpTransaction wrapping the exact same inner tx.
  assert.equal(submittedEnvelopes.length, 2);
  assert.ok(submittedEnvelopes[1] instanceof StellarSdk.FeeBumpTransaction);
  assert.equal(
    submittedEnvelopes[1].innerTransaction.hash().toString('hex'),
    innerHash,
  );
});

test('immediately escalates to fee bump when Horizon rejects with tx_insufficient_fee', async () => {
  const { tx } = buildSignedPaymentTx({ fee: '100' });
  const feeSource = StellarSdk.Keypair.random();
  const submitted = [];

  const mockServer = {
    fetchBaseFee: async () => '250',
    transactions: () => ({
      transaction: () => ({
        call: async () => {
          const err = new Error('Not Found');
          err.response = { status: 404 };
          throw err;
        },
      }),
    }),
    submitTransaction: async (envelope) => {
      submitted.push(envelope);
      if (submitted.length === 1) {
        const err = new Error('Transaction failed: tx_insufficient_fee');
        err.response = {
          status: 400,
          data: { extras: { result_codes: { transaction: 'tx_insufficient_fee' } } },
        };
        throw err;
      }
      return { hash: envelope.hash().toString('hex'), ledger: 6000, successful: true };
    },
  };

  const manager = new FeeBumpManager({
    server: mockServer,
    networkPassphrase: NETWORK_PASSPHRASE,
    sleep: async () => {},
  });

  const result = await manager.submitWithFeeBump({
    transaction: tx,
    feeSourceKeypair: feeSource,
  });

  assert.equal(result.status, 'confirmed');
  assert.equal(result.bumpCount, 1);
  assert.ok(result.finalFeeStroops >= 1000);
  assert.ok(submitted[1] instanceof StellarSdk.FeeBumpTransaction);
});

test('prevents double-spend when original transaction confirms right before or during fee-bump rebroadcast', async () => {
  const { tx } = buildSignedPaymentTx({ fee: '100' });
  const feeSource = StellarSdk.Keypair.random();
  const innerHash = tx.hash().toString('hex');

  let currentLedger = 7000;
  let confirmedOnChain = false;
  let submitCalls = 0;

  const mockServer = {
    fetchBaseFee: async () => '200',
    ledgers: () => ({
      order: () => ({
        limit: () => ({
          call: async () => ({ records: [{ sequence: currentLedger }] }),
        }),
      }),
    }),
    transactions: () => ({
      transaction: (hash) => ({
        call: async () => {
          if (confirmedOnChain && hash === innerHash) {
            return { hash: innerHash, ledger: 7003, successful: true };
          }
          const err = new Error('Not Found');
          err.response = { status: 404 };
          throw err;
        },
      }),
    }),
    submitTransaction: async () => {
      submitCalls += 1;
      if (submitCalls === 1) {
        const err = new Error('Timeout');
        err.response = { status: 504 };
        throw err;
      }
      // On fee-bump rebroadcast, original inner tx actually already landed -> Horizon returns tx_bad_seq.
      confirmedOnChain = true;
      const err = new Error('tx_bad_seq');
      err.response = {
        status: 400,
        data: { extras: { result_codes: { transaction: 'tx_bad_seq' } } },
      };
      throw err;
    },
  };

  const manager = new FeeBumpManager({
    server: mockServer,
    networkPassphrase: NETWORK_PASSPHRASE,
    stalledLedgerThreshold: 3,
    sleep: async () => {
      currentLedger += 1;
    },
  });

  const result = await manager.submitWithFeeBump({
    transaction: tx,
    feeSourceKeypair: feeSource,
  });

  // Recovered the already-confirmed inner transaction hash rather than failing or duplicating!
  assert.equal(result.status, 'confirmed');
  assert.equal(result.txHash, innerHash);
  assert.equal(result.ledger, 7003);
});

test('throws FeeBumpExhaustedError after maxBumpAttempts without confirmation', async () => {
  const { tx } = buildSignedPaymentTx({ fee: '100' });
  const feeSource = StellarSdk.Keypair.random();
  let currentLedger = 8000;

  const mockServer = {
    fetchBaseFee: async () => '100',
    ledgers: () => ({
      order: () => ({
        limit: () => ({
          call: async () => ({ records: [{ sequence: currentLedger }] }),
        }),
      }),
    }),
    transactions: () => ({
      transaction: () => ({
        call: async () => {
          const err = new Error('Not Found');
          err.response = { status: 404 };
          throw err;
        },
      }),
    }),
    submitTransaction: async () => {
      const err = new Error('Gateway Timeout 504');
      err.response = { status: 504 };
      throw err;
    },
  };

  const manager = new FeeBumpManager({
    server: mockServer,
    networkPassphrase: NETWORK_PASSPHRASE,
    stalledLedgerThreshold: 3,
    maxBumpAttempts: 2,
    sleep: async () => {
      currentLedger += 1;
    },
  });

  await assert.rejects(
    manager.submitWithFeeBump({
      transaction: tx,
      feeSourceKeypair: feeSource,
    }),
    (err) => {
      assert.ok(err instanceof FeeBumpExhaustedError);
      assert.equal(err.code, 'FEE_BUMP_EXHAUSTED');
      assert.equal(err.bumpCount, 2);
      return true;
    },
  );
});

test('computeBoostedFee enforces maxFeeCapStroops and rejects when cap is already reached', () => {
  const capped = computeBoostedFee({
    previousFeeStroops: 8000,
    recommendedBaseFeeStroops: 5000,
    operationCount: 2,
    feeMultiplier: 2,
    maxFeeCapStroops: 10000,
  });
  assert.equal(capped, 10000);

  assert.throws(
    () => computeBoostedFee({
      previousFeeStroops: 10000,
      recommendedBaseFeeStroops: 5000,
      maxFeeCapStroops: 10000,
    }),
    (err) => err instanceof FeeBumpCapExceededError && err.code === 'FEE_BUMP_CAP_EXCEEDED',
  );
});
