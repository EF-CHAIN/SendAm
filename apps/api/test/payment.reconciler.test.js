const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reconcileStaleTransactions } = require('../src/payment/payment.reconciler');

test('reconcileStaleTransactions: updates transaction status to success when txHash is verified on Horizon', async () => {
  const updated = [];
  const prismaMock = {
    transaction: {
      findMany: async () => [
        {
          id: 'tx_100',
          status: 'processing',
          amount: '10',
          txHash: 'hash_verified_100',
          createdAt: new Date(Date.now() - 10 * 60 * 1000),
          user: { wallets: [{ publicKey: 'G_SENDER' }] },
        },
      ],
      update: async (args) => {
        updated.push(args);
        return args;
      },
    },
  };

  const horizonServerMock = {
    transactions: () => ({
      transactionHash: (hash) => ({
        call: async () => {
          if (hash === 'hash_verified_100') {
            return { successful: true };
          }
          throw { response: { status: 404 } };
        },
      }),
    }),
  };

  const result = await reconcileStaleTransactions({
    prisma: prismaMock,
    staleAgeMs: 5 * 60 * 1000,
    horizonServer: horizonServerMock,
  });

  assert.equal(result.processedCount, 1);
  assert.equal(result.updatedCount, 1);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].where.id, 'tx_100');
  assert.equal(updated[0].data.status, 'success');
  assert.ok(updated[0].data.explorerUrl.includes('hash_verified_100'));
});

test('reconcileStaleTransactions: updates transaction status to success when matching payment is found in account history', async () => {
  const updated = [];
  const prismaMock = {
    transaction: {
      findMany: async () => [
        {
          id: 'tx_101',
          status: 'processing',
          amount: '25',
          destination: 'G_RECIPIENT',
          txHash: null,
          createdAt: new Date(Date.now() - 10 * 60 * 1000),
          user: { wallets: [{ publicKey: 'G_SENDER' }] },
        },
      ],
      update: async (args) => {
        updated.push(args);
        return args;
      },
    },
  };

  const horizonServerMock = {
    payments: () => ({
      forAccount: () => ({
        order: () => ({
          limit: () => ({
            call: async () => ({
              records: [
                {
                  type: 'payment',
                  amount: '25',
                  to: 'G_RECIPIENT',
                  transaction_hash: 'hash_from_history_101',
                },
              ],
            }),
          }),
        }),
      }),
    }),
  };

  const result = await reconcileStaleTransactions({
    prisma: prismaMock,
    staleAgeMs: 5 * 60 * 1000,
    horizonServer: horizonServerMock,
  });

  assert.equal(result.processedCount, 1);
  assert.equal(result.updatedCount, 1);
  assert.equal(updated[0].where.id, 'tx_101');
  assert.equal(updated[0].data.status, 'success');
  assert.equal(updated[0].data.txHash, 'hash_from_history_101');
});

test('reconcileStaleTransactions: marks transaction failed when max stale age exceeded without Horizon match', async () => {
  const updated = [];
  const prismaMock = {
    transaction: {
      findMany: async () => [
        {
          id: 'tx_102',
          status: 'processing',
          amount: '50',
          txHash: 'hash_not_found',
          createdAt: new Date(Date.now() - 30 * 60 * 1000), // 30 mins old (> 3 * 5m)
          user: { wallets: [{ publicKey: 'G_SENDER' }] },
          metadata: {},
        },
      ],
      update: async (args) => {
        updated.push(args);
        return args;
      },
    },
  };

  const horizonServerMock = {
    transactions: () => ({
      transactionHash: () => ({
        call: async () => {
          throw { response: { status: 404 } };
        },
      }),
    }),
    payments: () => ({
      forAccount: () => ({
        order: () => ({
          limit: () => ({
            call: async () => ({ records: [] }),
          }),
        }),
      }),
    }),
  };

  const result = await reconcileStaleTransactions({
    prisma: prismaMock,
    staleAgeMs: 5 * 60 * 1000,
    horizonServer: horizonServerMock,
  });

  assert.equal(result.processedCount, 1);
  assert.equal(result.updatedCount, 1);
  assert.equal(updated[0].where.id, 'tx_102');
  assert.equal(updated[0].data.status, 'failed');
});
