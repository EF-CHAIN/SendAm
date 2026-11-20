const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
const { randomInt, randomUUID } = require('node:crypto');
const { priceLoyaltyFee, redeemVoucher } = require('../src/pricing/loyaltyRebate');

test('prices fees using only the past 30 days of confirmed volume in the source asset', async () => {
  const now = new Date('2026-11-20T12:00:00Z');
  const db = {
    transaction: {
      findMany: async ({ where }) => {
        assert.equal(where.userId, 'user');
        assert.equal(where.asset, 'XLM');
        assert.equal(where.type, 'send');
        assert.equal(where.status, 'success');
        assert.equal(where.updatedAt.gte.toISOString(), '2026-10-21T12:00:00.000Z');
        return [
          { amount: '100', updatedAt: now },
          { amount: '1000', metadata: { confirmedAt: '2026-10-19T12:00:00Z' }, updatedAt: now },
        ];
      },
    },
    feeVoucher: { findMany: async () => [{ earnedById: 'earlier', amount: '0.1' }] },
  };
  const result = await priceLoyaltyFee({ db, userId: 'user', asset: 'XLM', amount: '50', now });
  assert.deepEqual(result, {
    fee: '0.3500000',
    loyalty: {
      tier: 'silver', volume: '100.0000000', discountBps: 1000,
      voucherId: 'earlier', voucherAmount: '0.1', rewardAmount: '0.0175000',
    },
  });
  assert.deepEqual(await priceLoyaltyFee({ db, asset: 'XLM', amount: '50' }), { fee: '0.5000000' });
});

test('anchor loyalty counts actual path spend at Stellar precision', async () => {
  const now = new Date('2026-11-20T12:00:00Z');
  const path = { amount: '10000.00', metadata: { pathPayment: { sourceDebit: '999.9999999' } }, updatedAt: now };
  const db = {
    transaction: { findMany: async () => [path] },
    feeVoucher: { findMany: async () => [] },
  };
  const standard = await priceLoyaltyFee({ db, userId: 'user', asset: 'GHS', amount: '100', now });
  assert.equal(standard.loyalty.tier, 'standard');
  path.metadata.pathPayment.sourceDebit = '1000.0000001';
  const silver = await priceLoyaltyFee({ db, userId: 'user', asset: 'GHS', amount: '100', now });
  assert.equal(silver.loyalty.tier, 'silver');
  assert.equal(silver.fee, '0.90');
});

const databaseUrl = process.env.TEST_DATABASE_URL;

test('Horizon confirmation credits one voucher and concurrent redemptions claim it once', { skip: !databaseUrl }, async () => {
  const { PrismaClient } = require('@prisma/client');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  mock.method(require('../src/common/audit.service'), 'writeAuditLog', async () => {});
  mock.method(require('../src/common/event.service'), 'appendEvent', async () => {});
  const { reconcileStaleTransactions } = require('../src/payment/payment.reconciler');
  const userId = randomUUID();
  const phoneNumber = `+234801${randomInt(10_000_000, 100_000_000)}`;
  await db.$executeRaw`INSERT INTO "User" (id, "phoneNumber", "updatedAt") VALUES (${userId}, ${phoneNumber}, NOW())`;
  const createPayment = (options) => db.transaction.create({
    data: { userId: userId, type: 'send', asset: 'XLM', amount: '100', ...options },
  });
  try {
    const earning = await createPayment({
      status: 'pending', txHash: `test-${userId}`, metadata: { loyalty: { rewardAmount: '0.1000000' } },
      createdAt: new Date(Date.now() - 600_000),
    });
    const horizonServer = {
      transactions: () => ({
        transactionHash: (hash) => ({ call: async () => hash === earning.txHash ? { successful: true } : null }),
      }),
      payments: () => { throw new Error('Unexpected payment history lookup'); },
    };
    const options = { prisma: db, horizonServer };
    await reconcileStaleTransactions(options);
    await reconcileStaleTransactions(options);

    const quote = await priceLoyaltyFee({ db, userId: userId, asset: 'XLM', amount: '100' });
    assert.equal(quote.fee, '0.8000000');
    assert.equal(quote.loyalty.voucherId, earning.id);
    assert.equal(await db.feeVoucher.count({ where: { userId: userId } }), 1);

    const payments = await Promise.all([createPayment({ status: 'processing' }), createPayment({ status: 'processing' })]);
    const attempts = await Promise.allSettled(payments.map((transaction) =>
      db.$transaction((client) => redeemVoucher({ db: client, transaction, loyalty: quote.loyalty }))));
    assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(attempts.find(({ status }) => status === 'rejected').reason.statusCode, 409);
  } finally {
    await db.transaction.deleteMany({ where: { userId } });
    await db.user.deleteMany({ where: { id: userId } });
    mock.restoreAll();
    await db.$disconnect();
  }
});
