const { test } = require('node:test');
const assert = require('node:assert/strict');
<<<<<<< HEAD
const {
  reconcileStaleTransactions,
  listLedgerDiscrepancies,
  listStuckPayments,
  operatorResolveStuckPayment,
} = require('../src/payment/payment.reconciler');
=======
const path = require('path');

// ---------------------------------------------------------------------------
// Mock config/stellar and wallet/stellar.adapter before requiring the SUT
// so the Stellar SDK (not installed locally) is never touched.
// ---------------------------------------------------------------------------
const injectMock = (relativeFromSrc, factory) => {
  const abs = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: factory() };
};

injectMock('config/stellar', () => ({ server: {}, StellarSdk: {} }));
injectMock('config/horizon', () => ({ isHorizonWriteUncertain: () => false, attachHorizonResilience: () => {} }));
injectMock('config/env', () => ({ stellar: { network: 'testnet', usdcIssuer: 'ISSUER' } }));
injectMock('utils/logger', () => ({ info: () => {}, warn: () => {}, error: () => {} }));
injectMock('wallet/stellar.adapter', () => ({
  getTransactionUrl: (hash) => `https://stellar.expert/explorer/testnet/tx/${hash}`,
}));

const { reconcileStaleTransactions } = require('../src/payment/payment.reconciler');
>>>>>>> upstream/main

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A transaction old enough to be picked up by reconciliation (past staleAgeMs)
// but recent enough that its ledger sequence window is still open (< 5 min).
const recentPendingTx = (overrides = {}) => ({
  id: 'tx_100',
  status: 'pending',
  amount: '10',
  txHash: 'hash_abc',
  createdAt: new Date(Date.now() - 6 * 60 * 1000), // 6 min old — past staleAgeMs(5m)
  metadata: {},
  user: { wallets: [{ publicKey: 'G_SENDER' }] },
  ...overrides,
});

// A transaction old enough that its ledger sequence window is definitively
// closed (> LEDGER_SEQUENCE_WINDOW_MS = 5 min) AND past max stale age (> 15m).
const expiredTx = (overrides = {}) => ({
  id: 'tx_old',
  status: 'pending',
  amount: '50',
  txHash: 'hash_old',
  createdAt: new Date(Date.now() - 30 * 60 * 1000), // 30 min old
  metadata: {},
  user: { wallets: [{ publicKey: 'G_SENDER' }] },
  ...overrides,
});

const makeHorizon = ({ txResult, payments = [] } = {}) => ({
  transactions: () => ({
    transactionHash: () => ({
      call: async () => {
        if (txResult === 'found') return { successful: true };
        if (txResult === 'failed') return { successful: false };
        throw { response: { status: 404 } };
      },
    }),
  }),
  payments: () => ({
    forAccount: () => ({
      order: () => ({ limit: () => ({ call: async () => ({ records: payments }) }) }),
    }),
  }),
});

const makePrisma = (txList) => {
  const updated = [];
  return {
    _updated: updated,
    transaction: {
      findMany: async () => txList,
      update: async (args) => { updated.push(args); return { ...args.where, ...args.data }; },
    },
  };
};

// ---------------------------------------------------------------------------
// Confirmed: Horizon returns successful=true → success + receipt callback
// ---------------------------------------------------------------------------
test('reconcileStaleTransactions: txHash confirmed on Horizon → success and receipt callback fired', async () => {
  const prisma = makePrisma([recentPendingTx()]);
  const receipts = [];

  await reconcileStaleTransactions({
    prisma,
    horizonServer: makeHorizon({ txResult: 'found' }),
    onReceipt: async (tx) => receipts.push(tx),
  });

  assert.equal(prisma._updated.length, 1);
  assert.equal(prisma._updated[0].data.status, 'success');
  assert.ok(prisma._updated[0].data.explorerUrl.includes('hash_abc'));
  assert.ok(prisma._updated[0].data.metadata.confirmedAt, 'confirmedAt must be recorded');
  assert.equal(receipts.length, 1, 'receipt callback must fire exactly once on confirmation');
});

// ---------------------------------------------------------------------------
// Ledger-backed failure: Horizon returns successful=false → failed immediately
// ---------------------------------------------------------------------------
test('reconcileStaleTransactions: txHash on ledger but successful=false → failed', async () => {
  const prisma = makePrisma([recentPendingTx()]);

  await reconcileStaleTransactions({
    prisma,
    horizonServer: makeHorizon({ txResult: 'failed' }),
  });

  assert.equal(prisma._updated[0].data.status, 'failed');
  assert.match(prisma._updated[0].data.metadata.reconciliationError, /unsuccessful/);
});

// ---------------------------------------------------------------------------
// Transient 404: window still open → no update, retry next cycle
// ---------------------------------------------------------------------------
test('reconcileStaleTransactions: Horizon 404 while ledger sequence window is open → no status change (retry)', async () => {
  // Transaction is 6 min old: past staleAgeMs(5m) but inside LEDGER_SEQUENCE_WINDOW_MS(5m)?
  // Actually 6 min > 5 min, so sequence window IS closed for the default.
  // Use a transaction only 5.5 min old to stay within the window.
  const tx = recentPendingTx({
    id: 'tx_fresh',
    createdAt: new Date(Date.now() - 5.5 * 60 * 1000), // 5.5 min > staleAgeMs but < window
  });
  // Override staleAgeMs to 5min but window is 5min — need tx inside the window.
  // Use a 2-min-old tx with staleAgeMs=1min so it's stale but window still open.
  const freshTx = recentPendingTx({
    id: 'tx_fresh2',
    createdAt: new Date(Date.now() - 2 * 60 * 1000), // 2 min old
  });
  const prisma = makePrisma([freshTx]);

  await reconcileStaleTransactions({
    prisma,
    staleAgeMs: 1 * 60 * 1000, // 1 min stale cutoff — tx is 2 min old, so it qualifies
    horizonServer: makeHorizon({ txResult: '404' }),
  });

  // No update — 404 is transient because ledger sequence window (5 min) hasn't closed yet
  assert.equal(prisma._updated.length, 0, 'pending tx must NOT be updated while window is open');
});

// ---------------------------------------------------------------------------
// Expired: 404 + ledger sequence window closed → expired (not failed)
// ---------------------------------------------------------------------------
test('reconcileStaleTransactions: Horizon 404 after ledger sequence window closed → expired', async () => {
  const prisma = makePrisma([expiredTx()]);

  await reconcileStaleTransactions({
    prisma,
    horizonServer: makeHorizon({ txResult: '404' }),
  });

  assert.equal(prisma._updated[0].data.status, 'expired');
  assert.equal(
    prisma._updated[0].data.metadata.reconciliationError,
    'ledger_sequence_expired',
    'reason must be ledger_sequence_expired, not a wall-clock message',
  );
  assert.ok(prisma._updated[0].data.metadata.expiredAt);
});

// ---------------------------------------------------------------------------
// No txHash path: match via payment history → success + receipt
// ---------------------------------------------------------------------------
test('reconcileStaleTransactions: no txHash, payment history match → success and receipt callback', async () => {
  const tx = expiredTx({ txHash: null, destination: 'G_RECIPIENT' });
  const prisma = makePrisma([tx]);
  const receipts = [];

  const horizonWithHistory = makeHorizon({
    payments: [{ type: 'payment', amount: '50', to: 'G_RECIPIENT', transaction_hash: 'hash_from_history' }],
  });

  await reconcileStaleTransactions({
    prisma,
    horizonServer: horizonWithHistory,
    onReceipt: async (t) => receipts.push(t),
  });

  assert.equal(prisma._updated[0].data.status, 'success');
  assert.equal(prisma._updated[0].data.txHash, 'hash_from_history');
  assert.equal(receipts.length, 1);
});

// ---------------------------------------------------------------------------
// Max stale age: no Horizon evidence + window closed → failed (ledger_sequence_expired)
// ---------------------------------------------------------------------------
test('reconcileStaleTransactions: no txHash, no history, window closed, max stale exceeded → failed with ledger_sequence_expired', async () => {
  const tx = expiredTx({ txHash: null });
  const prisma = makePrisma([tx]);

  await reconcileStaleTransactions({
    prisma,
    staleAgeMs: 5 * 60 * 1000,
    horizonServer: makeHorizon(), // 404 for txHash (but txHash is null anyway), no payment history
  });

  assert.equal(prisma._updated[0].data.status, 'failed');
  assert.equal(
    prisma._updated[0].data.metadata.reconciliationError,
    'ledger_sequence_expired',
  );
  assert.ok(prisma._updated[0].data.metadata.failedAt);
});

// ---------------------------------------------------------------------------
// Premature settlement prevention: window still open + no match → no update
// ---------------------------------------------------------------------------
test('reconcileStaleTransactions: no match found, window still open → no premature failure', async () => {
  const tx = recentPendingTx({ txHash: null, createdAt: new Date(Date.now() - 2 * 60 * 1000) });
  const prisma = makePrisma([tx]);

  await reconcileStaleTransactions({
    prisma,
    staleAgeMs: 1 * 60 * 1000,
    horizonServer: makeHorizon(),
  });

  assert.equal(prisma._updated.length, 0, 'must not fail a transaction while its window is still open');
});

// ---------------------------------------------------------------------------
// Empty set: nothing to process
// ---------------------------------------------------------------------------
test('reconcileStaleTransactions: no stale transactions returns zero counts', async () => {
  const prisma = makePrisma([]);

  const result = await reconcileStaleTransactions({ prisma, horizonServer: makeHorizon() });

  assert.equal(result.processedCount, 0);
  assert.equal(result.updatedCount, 0);
});

test('listLedgerDiscrepancies detects unbalanced journal entries', async () => {
  const report = await listLedgerDiscrepancies({
    prisma: {
      journalEntry: {
        findMany: async () => [
          {
            id: 'entry_bad',
            eventType: 'payment.reserved',
            transactionId: 'tx_bad',
            postings: [
              { asset: 'XLM', amount: '-10.0000000' },
              { asset: 'XLM', amount: '9.0000000' },
            ],
          },
        ],
      },
    },
  });

  assert.equal(report.checkedCount, 1);
  assert.equal(report.discrepancyCount, 1);
  assert.equal(report.discrepancies[0].type, 'unbalanced_entry');
});

test('listStuckPayments returns ledger evidence and retry history', async () => {
  const result = await listStuckPayments({
    prisma: {
      transaction: {
        findMany: async () => [
          {
            id: 'tx_stuck',
            status: 'processing',
            createdAt: new Date(Date.now() - 60 * 60 * 1000),
            metadata: { retryHistory: [{ action: 'retry' }] },
            ledgerEntries: [{ id: 'entry_1', postings: [] }],
          },
        ],
      },
    },
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].retryHistory.length, 1);
  assert.equal(result[0].ledgerEvidence.length, 1);
});

test('operatorResolveStuckPayment requires reason and records retry action without settling twice', async () => {
  await assert.rejects(() => operatorResolveStuckPayment({
    prisma: {},
    transactionId: 'tx_stuck',
    action: 'retry',
    reason: '',
    adminId: 'admin_1',
  }), /reason/);

  const updates = [];
  const prismaMock = {
    $transaction: async (fn) => fn({
      transaction: {
        findUnique: async () => ({ id: 'tx_stuck', status: 'pending', metadata: {} }),
        update: async ({ data }) => {
          updates.push(data);
          return { id: 'tx_stuck', ...data };
        },
      },
    }),
  };

  const updated = await operatorResolveStuckPayment({
    prisma: prismaMock,
    transactionId: 'tx_stuck',
    action: 'retry',
    reason: 'horizon timeout cleared',
    adminId: 'admin_1',
  });

  assert.equal(updated.status, 'processing');
  assert.equal(updates[0].metadata.retryHistory.length, 1);

  await assert.rejects(() => operatorResolveStuckPayment({
    prisma: {
      $transaction: async (fn) => fn({
        transaction: {
          findUnique: async () => ({ id: 'tx_done', status: 'success', metadata: {} }),
        },
      }),
    },
    transactionId: 'tx_done',
    action: 'retry',
    reason: 'checking duplicate',
    adminId: 'admin_1',
  }), /cannot be retried/);
});
