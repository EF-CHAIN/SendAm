const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
const { createConfirmationService, makeSummaryHash } = require('../src/whatsapp/paymentConfirmation.service');
const fixedNow = new Date('2030-01-01T00:00:00Z');

const makeDb = () => {
  const rows = [];
  let version = 0;
  const tx = {
    user: { update: async () => ({ confirmationVersion: ++version }) },
    paymentConfirmation: {
      updateMany: async ({ where, data }) => {
        let count = 0;
        rows.filter((row) => row.userId === where.userId && row.state === where.state).forEach((row) => { Object.assign(row, data); count += 1; });
        return { count };
      },
      create: async ({ data }) => { const row = { id: `c${rows.length + 1}`, state: 'pending', ...data }; rows.push(row); return row; },
    },
  };
  return {
    rows,
    $transaction: (callback) => callback(tx),
    paymentConfirmation: {
      findUnique: async ({ where }) => rows.find((row) => row.userId === where.userId_reference.userId && row.reference === where.userId_reference.reference),
      count: async ({ where }) => rows.filter((row) => row.userId === where.userId && row.state === where.state).length,
      updateMany: async ({ where, data }) => {
        const row = rows.find((item) => item.id === where.id && item.state === where.state && (!where.summaryHash || item.summaryHash === where.summaryHash));
        if (!row || (where.expiresAt?.gt && row.expiresAt <= where.expiresAt.gt)) return { count: 0 };
        Object.assign(row, data); return { count: 1 };
      },
      update: async ({ where, data }) => { const row = rows.find((item) => item.id === where.id); Object.assign(row, data); return row; },
    },
  };
};

test('new immutable confirmation supersedes the older request', async () => {
  const db = makeDb();
  const service = createConfirmationService(db, { now: () => fixedNow });
  const first = await service.create({ userId: 'u1', amount: '5', asset: 'XLM', destination: 'GA', recipientLabel: 'Ada', routeType: 'domestic' });
  const second = await service.create({ userId: 'u1', amount: '9', asset: 'XLM', destination: 'GB', recipientLabel: 'Bob', routeType: 'domestic' });
  assert.equal(first.state, 'superseded');
  assert.equal(second.state, 'pending');
  assert.equal(second.version, 2);
  assert.equal(first.amount, '5');
  assert.notEqual(first.summaryHash, second.summaryHash);
  assert.equal(first.summaryHash, makeSummaryHash(first));
});

test('only the referenced pending request can be atomically authorized once', async () => {
  const db = makeDb();
  const service = createConfirmationService(db, { now: () => fixedNow });
  const record = await service.create({ userId: 'u1', amount: '5', asset: 'XLM', destination: 'GA', routeType: 'domestic' });
  assert.equal(await service.authorize(record), true);
  assert.equal(await service.authorize(record), false);
  assert.equal(record.state, 'authorized');
});

test('cancelled and expired confirmations cannot authorize', async () => {
  const db = makeDb();
  const service = createConfirmationService(db, { now: () => fixedNow });
  const cancelled = await service.create({ userId: 'u1', amount: '5', asset: 'XLM', destination: 'GA', routeType: 'domestic' });
  assert.equal(await service.cancel(cancelled), true);
  assert.equal(await service.authorize(cancelled), false);
  const expired = await service.create({ userId: 'u1', amount: '6', asset: 'XLM', destination: 'GB', routeType: 'domestic' });
  expired.expiresAt = new Date('2029-12-31T23:59:59Z');
  assert.equal(await service.authorize(expired), false);
});
