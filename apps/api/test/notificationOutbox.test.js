const { test } = require('node:test');
const assert = require('node:assert/strict');

const outbox = require('../src/services/notificationOutbox.service');

/** Minimal in-memory stand-in for the Prisma notification delegate. */
const makeDb = ({ failCreate = null } = {}) => {
  const rows = new Map();
  let seq = 0;

  return {
    rows,
    notification: {
      async create({ data }) {
        if (failCreate) throw failCreate;
        if (data.idempotencyKey) {
          for (const row of rows.values()) {
            if (row.idempotencyKey === data.idempotencyKey) {
              const conflict = new Error('Unique constraint failed');
              conflict.code = 'P2002';
              throw conflict;
            }
          }
        }
        seq += 1;
        const row = { id: `n_${seq}`, sendAttempts: 0, claimedAt: null, ...data };
        rows.set(row.id, row);
        return row;
      },
      async findUnique({ where }) {
        for (const row of rows.values()) {
          if (where.idempotencyKey && row.idempotencyKey === where.idempotencyKey) return row;
          if (where.id && row.id === where.id) return row;
        }
        return null;
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const row of rows.values()) {
          if (where.id && row.id !== where.id) continue;
          if (where.status && typeof where.status === 'string' && row.status !== where.status) continue;
          if (where.status?.in && !where.status.in.includes(row.status)) continue;
          if (where.claimedAt?.lt && !(row.claimedAt && row.claimedAt < where.claimedAt.lt)) continue;
          for (const [key, value] of Object.entries(data)) {
            row[key] = value && value.increment ? (row[key] || 0) + value.increment : value;
          }
          count += 1;
        }
        return { count };
      },
      async update({ where, data }) {
        const row = rows.get(where.id);
        if (!row) throw new Error('not found');
        for (const [key, value] of Object.entries(data)) {
          if (value === undefined) continue;
          row[key] = value;
        }
        return row;
      },
      async findMany({ where, take }) {
        const out = [];
        for (const row of rows.values()) {
          if (where.status && row.status !== where.status) continue;
          if (where.claimedAt?.lt && !(row.claimedAt && row.claimedAt < where.claimedAt.lt)) continue;
          out.push(row);
        }
        return take ? out.slice(0, take) : out;
      },
    },
  };
};

const financial = { userId: 'u1', type: 'payment_sent', referenceType: 'Transaction', referenceId: 't1' };
const chatty = { userId: 'u1', type: 'generic' };

test('financial and compliance notifications require a durable record', () => {
  assert.equal(outbox.requiresDurableRecord({ type: 'payment_sent' }), true);
  assert.equal(outbox.requiresDurableRecord({ type: 'kyc_status' }), true);
  assert.equal(outbox.requiresDurableRecord({ type: 'generic' }), false);
  assert.equal(outbox.requiresDurableRecord(null), false);
});

test('the idempotency key is stable for the same logical send', () => {
  const a = outbox.buildIdempotencyKey(financial, '+1', 'hello');
  const b = outbox.buildIdempotencyKey(financial, '+1', 'hello');
  assert.equal(a, b);
  assert.match(a, /Transaction:t1/);
});

test('sends without a reference still get a deterministic key', () => {
  const a = outbox.buildIdempotencyKey(chatty, '+1', 'hello');
  const b = outbox.buildIdempotencyKey(chatty, '+1', 'hello');
  const c = outbox.buildIdempotencyKey(chatty, '+1', 'different body');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('an explicit key on the notification wins', () => {
  assert.equal(outbox.buildIdempotencyKey({ ...chatty, idempotencyKey: 'fixed' }, '+1', 'x'), 'fixed');
});

test('the intent row is queued before any provider call', async () => {
  const db = makeDb();
  const row = await outbox.reserveOutboundNotification(db, {
    notification: financial, to: '+1', body: 'sent 5 USDC',
  });

  assert.equal(row.status, 'queued');
  assert.equal(row.recipient, '+1');
  assert.equal(row.providerMessageId, undefined);
  assert.equal(db.rows.size, 1);
});

test('re-reserving the same logical send reuses the row instead of duplicating', async () => {
  const db = makeDb();
  const first = await outbox.reserveOutboundNotification(db, { notification: financial, to: '+1', body: 'x' });
  const second = await outbox.reserveOutboundNotification(db, { notification: financial, to: '+1', body: 'x' });

  assert.equal(first.id, second.id);
  assert.equal(db.rows.size, 1);
});

test('a persistence failure aborts a financial send rather than sending untracked', async () => {
  const db = makeDb({ failCreate: new Error('db down') });
  await assert.rejects(
    () => outbox.reserveOutboundNotification(db, { notification: financial, to: '+1', body: 'x' }),
    (error) => {
      assert.equal(error.code, 'NOTIFICATION_PERSISTENCE_FAILED');
      return true;
    },
  );
});

test('a persistence failure for a low-stakes send degrades to untracked', async () => {
  const db = makeDb({ failCreate: new Error('db down') });
  const row = await outbox.reserveOutboundNotification(db, { notification: chatty, to: '+1', body: 'menu' });
  assert.equal(row, null);
});

test('claiming is atomic: exactly one caller wins', async () => {
  const db = makeDb();
  const row = await outbox.reserveOutboundNotification(db, { notification: financial, to: '+1', body: 'x' });

  const [first, second] = [await outbox.claimForSend(db, row.id), await outbox.claimForSend(db, row.id)];
  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(db.rows.get(row.id).status, 'sending');
  assert.equal(db.rows.get(row.id).sendAttempts, 1);
});

test('the provider result attaches to the pre-existing row', async () => {
  const db = makeDb();
  const row = await outbox.reserveOutboundNotification(db, { notification: financial, to: '+1', body: 'x' });
  await outbox.claimForSend(db, row.id);
  await outbox.attachProviderResult(db, row.id, { providerMessageId: 'wamid.1', status: 'sent' });

  const stored = db.rows.get(row.id);
  assert.equal(stored.status, 'sent');
  assert.equal(stored.providerMessageId, 'wamid.1');
  assert.ok(stored.sentAt instanceof Date);
  assert.equal(db.rows.size, 1, 'must update the reserved row, not insert a second');
});

test('a definite rejection is recorded as failed', async () => {
  const db = makeDb();
  const row = await outbox.reserveOutboundNotification(db, { notification: financial, to: '+1', body: 'x' });
  await outbox.claimForSend(db, row.id);
  await outbox.markSendFailed(db, row.id, 'invalid recipient');

  assert.equal(db.rows.get(row.id).status, 'failed');
  assert.equal(db.rows.get(row.id).error, 'invalid recipient');
});

test('a crash mid-send leaves an unresolved row, not a failed one', async () => {
  const db = makeDb();
  const row = await outbox.reserveOutboundNotification(db, { notification: financial, to: '+1', body: 'x' });
  await outbox.claimForSend(db, row.id);

  // Claimed, handed to the provider, never resolved.
  const flagged = await outbox.markUnresolved(db, row.id, 'no provider response');
  assert.equal(flagged, true);
  // Deliberately not 'failed': we do not know it failed, and saying so would
  // licence an unsafe automatic resend of a financial notification.
  assert.equal(db.rows.get(row.id).status, 'unknown');
});

test('reconciliation only picks up sends stuck past the timeout', async () => {
  const db = makeDb();
  const stale = await outbox.reserveOutboundNotification(db, { notification: financial, to: '+1', body: 'x' });
  await outbox.claimForSend(db, stale.id, { now: new Date(Date.now() - 60 * 60 * 1000) });

  const fresh = await outbox.reserveOutboundNotification(db, {
    notification: { ...financial, referenceId: 't2' }, to: '+2', body: 'y',
  });
  await outbox.claimForSend(db, fresh.id);

  const flagged = await outbox.reconcileUnresolvedSends(db, { olderThanMs: 5 * 60 * 1000 });
  assert.deepEqual(flagged, [stale.id]);
  assert.equal(db.rows.get(fresh.id).status, 'sending');
});

test('an already-sent row is not re-claimed', async () => {
  const db = makeDb();
  const row = await outbox.reserveOutboundNotification(db, { notification: financial, to: '+1', body: 'x' });
  await outbox.claimForSend(db, row.id);
  await outbox.attachProviderResult(db, row.id, { providerMessageId: 'wamid.1', status: 'sent' });

  assert.equal(await outbox.claimForSend(db, row.id), false);
});
