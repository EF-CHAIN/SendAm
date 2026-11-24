const { test } = require('node:test');
const assert = require('node:assert/strict');
const StellarSdk = require('@stellar/stellar-sdk');

const {
  ChannelAccountPool,
  ChannelPoolTimeoutError,
} = require('../src/wallet/channelAccountPool');

const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;

/**
 * Stateful in-memory Horizon simulator that strictly validates Stellar sequence numbers
 * per transaction source account and throws `tx_bad_seq` on any collision.
 */
const createStatefulHorizonMock = ({ basePublicKey, initialChannelBalances = {}, delayMs = 5 } = {}) => {
  const accounts = new Map();
  accounts.set(basePublicKey, { sequence: 1000n, balance: 100000 });

  const submittedTxs = [];
  const replenishments = [];
  const provisions = [];
  let badSeqCollisions = 0;

  const ensureAccount = (pubKey, balance = 5.0) => {
    if (!accounts.has(pubKey)) {
      accounts.set(pubKey, { sequence: 100n, balance });
    }
    return accounts.get(pubKey);
  };

  for (const [pubKey, bal] of Object.entries(initialChannelBalances)) {
    accounts.set(pubKey, { sequence: 100n, balance: bal });
  }

  const server = {
    loadAccount: async (publicKey) => {
      const state = accounts.get(publicKey);
      if (!state) {
        const err = new Error('Account not found');
        err.response = { status: 404 };
        throw err;
      }
      const acc = new StellarSdk.Account(publicKey, state.sequence.toString());
      acc.balances = [{ asset_type: 'native', balance: state.balance.toFixed(7) }];
      return acc;
    },
    fetchBaseFee: async () => '100',
    submitTransaction: async (tx) => {
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }

      const source = tx.source;
      const state = accounts.get(source);
      if (!state) {
        throw new Error(`Source account ${source} does not exist`);
      }

      const txSeq = BigInt(tx.sequence);
      const expectedSeq = state.sequence + 1n;
      if (txSeq !== expectedSeq) {
        badSeqCollisions += 1;
        const err = new Error('Transaction failed: tx_bad_seq');
        err.response = {
          status: 400,
          data: {
            extras: {
              result_codes: { transaction: 'tx_bad_seq' },
            },
          },
        };
        throw err;
      }

      // Advance sequence atomically and deduct fee.
      state.sequence = txSeq;
      state.balance = Math.max(0, state.balance - Number(tx.fee) / 1e7);

      for (const op of tx.operations) {
        if (op.type === 'createAccount') {
          ensureAccount(op.destination, Number(op.startingBalance));
          provisions.push({ destination: op.destination, amount: Number(op.startingBalance) });
        } else if (op.type === 'payment' && source === basePublicKey) {
          const target = accounts.get(op.destination);
          if (target) {
            target.balance += Number(op.amount);
            replenishments.push({ destination: op.destination, amount: Number(op.amount) });
          }
        }
      }

      submittedTxs.push(tx);
      return {
        hash: tx.hash().toString('hex'),
        successful: true,
        ledger: 50000 + submittedTxs.length,
      };
    },
  };

  return {
    server,
    accounts,
    submittedTxs,
    replenishments,
    provisions,
    getBadSeqCollisions: () => badSeqCollisions,
  };
};

test('supports 50 concurrent payment submissions without sequence number collisions', async () => {
  const baseKeypair = StellarSdk.Keypair.random();
  const channelKeypairs = Array.from({ length: 50 }, () => StellarSdk.Keypair.random());
  const initialChannelBalances = Object.fromEntries(
    channelKeypairs.map((kp) => [kp.publicKey(), 5.0]),
  );

  const horizon = createStatefulHorizonMock({
    basePublicKey: baseKeypair.publicKey(),
    initialChannelBalances,
    delayMs: 5,
  });

  const pool = new ChannelAccountPool({
    baseKeypair,
    channelSecrets: channelKeypairs.map((kp) => kp.secret()),
    server: horizon.server,
    networkPassphrase: NETWORK_PASSPHRASE,
    minBalanceXlm: 2.0,
    targetBalanceXlm: 5.0,
  });

  const destination = StellarSdk.Keypair.random().publicKey();

  // Fire 50 concurrent payments simultaneously.
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, idx) => pool.submitPayment({
      destination,
      amount: (idx + 1).toFixed(2),
      asset: 'XLM',
    })),
  );

  assert.equal(results.length, 50);
  assert.equal(horizon.getBadSeqCollisions(), 0);

  // Every concurrent submission used a distinct channel account.
  const usedChannels = new Set(results.map((r) => r.channelPublicKey));
  assert.equal(usedChannels.size, 50);

  // Verify base account is the sole source of funds on every payment operation,
  // while the outer transaction source is the channel account.
  for (const tx of horizon.submittedTxs) {
    assert.notEqual(tx.source, baseKeypair.publicKey());
    assert.equal(tx.operations.length, 1);
    assert.equal(tx.operations[0].type, 'payment');
    assert.equal(tx.operations[0].source, baseKeypair.publicKey());
    assert.equal(tx.signatures.length, 2);
  }

  const stats = pool.getStats();
  assert.equal(stats.totalSubmissions, 50);
  assert.equal(stats.inUseChannels, 0);
  assert.equal(stats.availableChannels, 50);
});

test('queues overflow concurrent submissions cleanly beyond pool size without collisions', async () => {
  const baseKeypair = StellarSdk.Keypair.random();
  const channelKeypairs = Array.from({ length: 10 }, () => StellarSdk.Keypair.random());
  const initialChannelBalances = Object.fromEntries(
    channelKeypairs.map((kp) => [kp.publicKey(), 5.0]),
  );

  const horizon = createStatefulHorizonMock({
    basePublicKey: baseKeypair.publicKey(),
    initialChannelBalances,
    delayMs: 2,
  });

  const pool = new ChannelAccountPool({
    baseKeypair,
    channelSecrets: channelKeypairs.map((kp) => kp.secret()),
    server: horizon.server,
    networkPassphrase: NETWORK_PASSPHRASE,
  });

  const destination = StellarSdk.Keypair.random().publicKey();
  const results = await Promise.all(
    Array.from({ length: 50 }, () => pool.submitPayment({
      destination,
      amount: '1.00',
      asset: 'XLM',
    })),
  );

  assert.equal(results.length, 50);
  assert.equal(horizon.getBadSeqCollisions(), 0);
  assert.equal(pool.getStats().totalSubmissions, 50);
  assert.equal(pool.getStats().queuedRequests, 0);
});

test('auto-replenishes channel reserves from base account when balance drops below threshold', async () => {
  const baseKeypair = StellarSdk.Keypair.random();
  const channelKeypair = StellarSdk.Keypair.random();

  const horizon = createStatefulHorizonMock({
    basePublicKey: baseKeypair.publicKey(),
    initialChannelBalances: {
      [channelKeypair.publicKey()]: 1.2, // Below minBalanceXlm (2.0)
    },
    delayMs: 0,
  });

  const pool = new ChannelAccountPool({
    baseKeypair,
    channelSecrets: [channelKeypair.secret()],
    server: horizon.server,
    networkPassphrase: NETWORK_PASSPHRASE,
    minBalanceXlm: 2.0,
    targetBalanceXlm: 5.0,
  });

  const destination = StellarSdk.Keypair.random().publicKey();
  await pool.submitPayment({ destination, amount: '5.00', asset: 'XLM' });

  assert.equal(horizon.replenishments.length, 1);
  assert.equal(horizon.replenishments[0].destination, channelKeypair.publicKey());
  assert.ok(horizon.replenishments[0].amount >= 3.79);
  assert.equal(pool.getStats().totalReplenishments, 1);
  assert.ok(horizon.accounts.get(channelKeypair.publicKey()).balance >= 4.9);
});

test('auto-provisions uncreated channel accounts on first use', async () => {
  const baseKeypair = StellarSdk.Keypair.random();
  const channelKeypair = StellarSdk.Keypair.random();

  // Channel account is NOT in initialChannelBalances (simulates 404 on Horizon).
  const horizon = createStatefulHorizonMock({
    basePublicKey: baseKeypair.publicKey(),
    initialChannelBalances: {},
    delayMs: 0,
  });

  const pool = new ChannelAccountPool({
    baseKeypair,
    channelSecrets: [channelKeypair.secret()],
    server: horizon.server,
    networkPassphrase: NETWORK_PASSPHRASE,
    initialFundingXlm: 5.0,
    autoProvision: true,
  });

  const destination = StellarSdk.Keypair.random().publicKey();
  const result = await pool.submitPayment({ destination, amount: '2.00', asset: 'XLM' });

  assert.equal(horizon.provisions.length, 1);
  assert.equal(horizon.provisions[0].destination, channelKeypair.publicKey());
  assert.equal(result.channelPublicKey, channelKeypair.publicKey());
  assert.equal(pool.getStats().totalProvisions, 1);
});

test('recovers automatically from external tx_bad_seq by resyncing channel sequence', async () => {
  const baseKeypair = StellarSdk.Keypair.random();
  const channelKeypair = StellarSdk.Keypair.random();

  const horizon = createStatefulHorizonMock({
    basePublicKey: baseKeypair.publicKey(),
    initialChannelBalances: { [channelKeypair.publicKey()]: 5.0 },
    delayMs: 0,
  });

  const pool = new ChannelAccountPool({
    baseKeypair,
    channelSecrets: [channelKeypair.secret()],
    server: horizon.server,
    networkPassphrase: NETWORK_PASSPHRASE,
  });

  const destination = StellarSdk.Keypair.random().publicKey();
  await pool.submitPayment({ destination, amount: '1.00', asset: 'XLM' });

  // Simulate an external transaction bumping the channel's on-chain sequence unexpectedly.
  horizon.accounts.get(channelKeypair.publicKey()).sequence += 5n;

  const second = await pool.submitPayment({ destination, amount: '1.00', asset: 'XLM' });
  assert.ok(second.txHash);
  assert.equal(pool.getStats().sequenceResyncs, 1);
});

test('throws ChannelPoolTimeoutError when all channels remain busy past acquireTimeoutMs', async () => {
  const baseKeypair = StellarSdk.Keypair.random();
  const channelKeypair = StellarSdk.Keypair.random();

  const pool = new ChannelAccountPool({
    baseKeypair,
    channelSecrets: [channelKeypair.secret()],
    networkPassphrase: NETWORK_PASSPHRASE,
    acquireTimeoutMs: 40,
  });

  const lease = await pool.acquire();
  try {
    await assert.rejects(
      pool.acquire({ timeoutMs: 30 }),
      (err) => err instanceof ChannelPoolTimeoutError && err.code === 'CHANNEL_POOL_TIMEOUT',
    );
  } finally {
    lease.release();
  }
});

test('checkAndReplenishAll tops up low-balance idle channels', async () => {
  const baseKeypair = StellarSdk.Keypair.random();
  const ch1 = StellarSdk.Keypair.random();
  const ch2 = StellarSdk.Keypair.random();

  const horizon = createStatefulHorizonMock({
    basePublicKey: baseKeypair.publicKey(),
    initialChannelBalances: {
      [ch1.publicKey()]: 1.1,
      [ch2.publicKey()]: 4.8,
    },
    delayMs: 0,
  });

  const pool = new ChannelAccountPool({
    baseKeypair,
    channelSecrets: [ch1.secret(), ch2.secret()],
    server: horizon.server,
    networkPassphrase: NETWORK_PASSPHRASE,
    minBalanceXlm: 2.0,
    targetBalanceXlm: 5.0,
  });

  const swept = await pool.checkAndReplenishAll();
  assert.equal(swept.length, 1);
  assert.equal(swept[0].publicKey, ch1.publicKey());
  assert.equal(swept[0].replenished, true);
  assert.equal(horizon.replenishments.length, 1);
});
