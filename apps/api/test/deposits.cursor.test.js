'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { pollWallet, isCursorAhead, persistCursorIfAhead } = require('../src/jobs/deposits.jobs');

const PUBLIC_KEY = 'GPUBLICKEY123';

const horizonWith = (records) => ({
  payments: () => ({
    forAccount: () => ({
      order: () => ({
        limit: () => ({
          cursor: (c) => ({
            call: async () => ({ records: records.filter((r) => BigInt(r.paging_token) > BigInt(c)) }),
          }),
        }),
      }),
    }),
  }),
});

const payment = (token, amount = '5.0000000') => ({
  id: `op${token}`,
  paging_token: token,
  type: 'payment',
  to: PUBLIC_KEY,
  amount,
  asset_type: 'native',
});

// In-memory "database": wallet cursor + outbox share one commit boundary.
const makeDb = (initialCursor) => {
  const state = { cursor: initialCursor, outbox: new Map(), failNextOutbox: false };
  const build = (store) => ({
    wallet: {
      findUnique: async () => ({ paymentCursor: store.cursor }),
      update: async ({ data }) => { store.cursor = data.paymentCursor; },
    },
    depositOutboxRecord: {
      upsert: async ({ where, create }) => {
        if (store.failNextOutbox) throw new Error('simulated crash mid-transaction');
        if (!store.outbox.has(where.stellarPaymentId)) store.outbox.set(where.stellarPaymentId, { ...create });
      },
      findUnique: async ({ where }) => store.outbox.get(where.stellarPaymentId) || null,
      updateMany: async ({ where, data }) => {
        const row = store.outbox.get(where.stellarPaymentId);
        if (row) Object.assign(row, data);
      },
    },
  });
  const db = build(state);
  db.$transaction = async (fn) => {
    // Snapshot so a thrown error rolls the whole transaction back.
    const snapshot = { cursor: state.cursor, outbox: new Map(state.outbox) };
    try {
      return await fn(db);
    } catch (error) {
      state.cursor = snapshot.cursor;
      state.outbox = snapshot.outbox;
      throw error;
    }
  };
  return { db, state };
};

const walletRow = (cursor) => ({ id: 'w1', userId: 'u1', publicKey: PUBLIC_KEY, phoneNumber: '+2348000000001', paymentCursor: cursor });

describe('isCursorAhead', () => {
  test('compares Horizon paging tokens numerically, not lexically', () => {
    assert.equal(isCursorAhead('101', '100'), true);
    assert.equal(isCursorAhead('1000', '999'), true, 'lexical comparison would get this wrong');
    assert.equal(isCursorAhead('99', '100'), false);
    assert.equal(isCursorAhead('100', '100'), false);
    assert.equal(isCursorAhead('100', null), true);
    assert.equal(isCursorAhead(null, '100'), false);
    assert.equal(isCursorAhead('cursor_2', 'cursor_1'), true, 'uncomparable tokens still advance when different');
    assert.equal(isCursorAhead('cursor_1', 'cursor_1'), false);
    assert.equal(isCursorAhead('4388234234234234234', '4388234234234234233'), true, 'beyond Number precision');
  });

  test('persistCursorIfAhead never rewinds the stored cursor', async () => {
    const { db, state } = makeDb('500');
    assert.equal(await persistCursorIfAhead(db, 'w1', '400'), false);
    assert.equal(state.cursor, '500');
    assert.equal(await persistCursorIfAhead(db, 'w1', '600'), true);
    assert.equal(state.cursor, '600');
  });
});

describe('deposit cursor persistence and crash recovery', () => {
  test('cursor and outbox row are committed together, so a crash loses neither', async () => {
    const { db, state } = makeDb('100');
    state.failNextOutbox = true;
    const notifications = [];
    const deps = { horizon: horizonWith([payment('101')]), prismaClient: db, notify: async (...a) => { notifications.push(a); }, fetchRate: async () => null };

    await assert.rejects(pollWallet(walletRow('100'), deps), /simulated crash/);
    assert.equal(state.cursor, '100', 'cursor must roll back with the failed outbox write');
    assert.equal(state.outbox.size, 0);
    assert.equal(notifications.length, 0);

    // Worker restarts and resumes from the persisted cursor: the payment is picked up.
    state.failNextOutbox = false;
    await pollWallet(walletRow(state.cursor), deps);
    assert.equal(state.cursor, '101');
    assert.equal(state.outbox.size, 1);
    assert.equal(notifications.length, 1);
  });

  test('restart resumes from the saved cursor without skipping or duplicating payments', async () => {
    const { db, state } = makeDb('100');
    const notifications = [];
    const horizon = horizonWith([payment('101'), payment('102'), payment('103')]);
    const deps = { horizon, prismaClient: db, notify: async (...a) => { notifications.push(a); }, fetchRate: async () => null };

    await pollWallet(walletRow('100'), deps);
    assert.equal(state.cursor, '103');
    assert.equal(notifications.length, 3);

    // "Restart": a fresh poll built from the persisted cursor sees nothing new.
    await pollWallet(walletRow(state.cursor), deps);
    assert.equal(notifications.length, 3, 'no duplicate notifications after restart');
    assert.equal(state.outbox.size, 3);
  });

  test('replaying an old cursor does not double-credit or rewind the saved position', async () => {
    const { db, state } = makeDb('100');
    const notifications = [];
    const horizon = horizonWith([payment('101'), payment('102')]);
    const deps = { horizon, prismaClient: db, notify: async (...a) => { notifications.push(a); }, fetchRate: async () => null };

    await pollWallet(walletRow('100'), deps);
    assert.equal(state.cursor, '102');
    assert.equal(notifications.length, 2);

    // A stale replica / replayed call polls again from the OLD cursor.
    await pollWallet(walletRow('100'), deps);
    assert.equal(state.cursor, '102', 'cursor must stay forward-only');
    assert.equal(state.outbox.size, 2, 'unique outbox key prevents a second credit record');
    assert.equal(notifications.length, 2, 'already-delivered payments are not re-notified');
  });
});
