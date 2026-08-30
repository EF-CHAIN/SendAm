const { test } = require('node:test');
const assert = require('node:assert/strict');

const inbox = require('../src/services/webhookInbox.service');

/** In-memory stand-in for the Prisma webhookInboxEvent delegate. */
const makeDb = ({ failCreate = null } = {}) => {
  const rows = new Map();
  let seq = 0;

  const matches = (row, where) => {
    if (where.id && row.id !== where.id) return false;
    if (typeof where.status === 'string' && row.status !== where.status) return false;
    if (where.status?.in && !where.status.in.includes(row.status)) return false;
    if (where.nextAttemptAt?.lte && !(row.nextAttemptAt <= where.nextAttemptAt.lte)) return false;
    return true;
  };

  return {
    rows,
    webhookInboxEvent: {
      async create({ data }) {
        if (failCreate) throw failCreate;
        for (const row of rows.values()) {
          if (row.provider === (data.provider || 'meta') && row.eventKey === data.eventKey) {
            const conflict = new Error('Unique constraint failed');
            conflict.code = 'P2002';
            throw conflict;
          }
        }
        seq += 1;
        const row = {
          id: `e_${seq}`,
          provider: 'meta',
          status: 'pending',
          attempts: 0,
          lastError: null,
          claimedAt: null,
          nextAttemptAt: new Date(0),
          processedAt: null,
          receivedAt: new Date(seq),
          ...data,
        };
        rows.set(row.id, row);
        return row;
      },
      async findUnique({ where }) {
        for (const row of rows.values()) {
          if (where.provider_eventKey) {
            const { provider, eventKey } = where.provider_eventKey;
            if (row.provider === provider && row.eventKey === eventKey) return row;
          }
          if (where.id && row.id === where.id) return row;
        }
        return null;
      },
      async findMany({ where, take, orderBy }) {
        let out = [...rows.values()].filter((row) => matches(row, where));
        if (orderBy?.receivedAt === 'asc') out.sort((a, b) => a.receivedAt - b.receivedAt);
        return take ? out.slice(0, take) : out;
      },
      async findFirst({ where, orderBy }) {
        const found = await this.findMany({ where, orderBy });
        return found[0] || null;
      },
      async count({ where }) {
        return [...rows.values()].filter((row) => matches(row, where)).length;
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const row of rows.values()) {
          if (!matches(row, where)) continue;
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
        Object.assign(row, data);
        return row;
      },
    },
  };
};

const statusEntry = (overrides = {}) => ({
  id: 'wamid.1', status: 'delivered', timestamp: '1700000000', ...overrides,
});

test('event identity is per batch item, not per request', () => {
  const a = inbox.statusEventKey(statusEntry());
  assert.equal(a, inbox.statusEventKey(statusEntry()));
  assert.notEqual(a, inbox.statusEventKey(statusEntry({ status: 'read' })));
  assert.notEqual(a, inbox.statusEventKey(statusEntry({ id: 'wamid.2' })));
  assert.notEqual(a, inbox.statusEventKey(statusEntry({ timestamp: '1700000001' })));
});

test('a callback is durable before any processing happens', async () => {
  const db = makeDb();
  const { stored, failed } = await inbox.ingestStatusBatch(db, [statusEntry()]);

  assert.equal(stored.length, 1);
  assert.equal(failed.length, 0);
  assert.equal(stored[0].status, 'pending');
  assert.equal(stored[0].processedAt, null);
  assert.deepEqual(stored[0].payload, statusEntry());
});

test('a redelivered batch is idempotent per item', async () => {
  const db = makeDb();
  await inbox.ingestStatusBatch(db, [statusEntry(), statusEntry({ id: 'wamid.2' })]);
  const second = await inbox.ingestStatusBatch(db, [statusEntry(), statusEntry({ id: 'wamid.2' })]);

  assert.equal(db.rows.size, 2, 'redelivery must not create duplicate rows');
  assert.equal(second.stored.length, 0);
  assert.equal(second.duplicates.length, 2);
});

test('partial batch progress survives: new items store even alongside duplicates', async () => {
  const db = makeDb();
  await inbox.ingestStatusBatch(db, [statusEntry()]);
  const second = await inbox.ingestStatusBatch(db, [statusEntry(), statusEntry({ id: 'wamid.9' })]);

  assert.equal(second.duplicates.length, 1);
  assert.equal(second.stored.length, 1);
  assert.equal(db.rows.size, 2);
});

test('an ingestion failure is reported so the caller can refuse to acknowledge', async () => {
  const db = makeDb({ failCreate: new Error('db down') });
  const { stored, failed } = await inbox.ingestStatusBatch(db, [statusEntry()]);

  assert.equal(stored.length, 0);
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /db down/);
});

test('draining processes each event exactly once', async () => {
  const db = makeDb();
  await inbox.ingestStatusBatch(db, [statusEntry(), statusEntry({ id: 'wamid.2' })]);

  const seen = [];
  const result = await inbox.drainInbox(db, (event) => { seen.push(event.payload.id); });

  assert.equal(result.processed, 2);
  assert.deepEqual(seen, ['wamid.1', 'wamid.2']);
  [...db.rows.values()].forEach((row) => {
    assert.equal(row.status, 'processed');
    assert.ok(row.processedAt);
  });

  // A second drain finds nothing left to do.
  assert.equal((await inbox.drainInbox(db, () => { throw new Error('should not run'); })).processed, 0);
});

test('one failing event does not block the rest of the queue', async () => {
  const db = makeDb();
  await inbox.ingestStatusBatch(db, [statusEntry(), statusEntry({ id: 'wamid.2' })]);

  const result = await inbox.drainInbox(db, (event) => {
    if (event.payload.id === 'wamid.1') throw new Error('handler blew up');
  });

  assert.equal(result.processed, 1);
  assert.equal(result.failed, 1);
});

test('a failed event is retried with backoff, not discarded', async () => {
  const db = makeDb();
  await inbox.ingestStatusBatch(db, [statusEntry()]);
  const now = new Date(1_000_000);

  await inbox.drainInbox(db, () => { throw new Error('transient'); }, { now });

  const row = [...db.rows.values()][0];
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 1);
  assert.match(row.lastError, /transient/);
  assert.ok(row.nextAttemptAt > now, 'must be scheduled for a later attempt');
});

test('backoff grows and is capped', () => {
  assert.equal(inbox.backoffMs(1), 5_000);
  assert.equal(inbox.backoffMs(2), 10_000);
  assert.ok(inbox.backoffMs(3) > inbox.backoffMs(2));
  assert.equal(inbox.backoffMs(99), 15 * 60 * 1000);
});

test('an event is dead-lettered after exhausting its retries, and kept', async () => {
  const db = makeDb();
  await inbox.ingestStatusBatch(db, [statusEntry()]);
  const row = [...db.rows.values()][0];

  await inbox.markFailed(db, row.id, new Error('permanent'), { attempts: inbox.MAX_ATTEMPTS });

  assert.equal(row.status, 'dead_letter');
  assert.equal(db.rows.size, 1, 'dead-lettered events are kept, never discarded');
});

test('an operator can replay a dead-lettered event', async () => {
  const db = makeDb();
  await inbox.ingestStatusBatch(db, [statusEntry()]);
  const row = [...db.rows.values()][0];
  await inbox.markFailed(db, row.id, new Error('permanent'), { attempts: inbox.MAX_ATTEMPTS });

  assert.equal(await inbox.replayEvent(db, row.id), true);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 0);
  assert.equal(row.lastError, null);

  const seen = [];
  await inbox.drainInbox(db, (event) => seen.push(event.payload.id));
  assert.deepEqual(seen, ['wamid.1']);
});

test('replaying an already-processed event is refused', async () => {
  const db = makeDb();
  await inbox.ingestStatusBatch(db, [statusEntry()]);
  await inbox.drainInbox(db, () => {});
  const row = [...db.rows.values()][0];

  assert.equal(await inbox.replayEvent(db, row.id), false);
  assert.equal(row.status, 'processed');
});

test('claiming is atomic: two drains cannot process the same event', async () => {
  const db = makeDb();
  await inbox.ingestStatusBatch(db, [statusEntry()]);
  const row = [...db.rows.values()][0];

  assert.equal(await inbox.claimEvent(db, row.id), true);
  assert.equal(await inbox.claimEvent(db, row.id), false);
});

test('stats report backlog depth and the age of the oldest unprocessed event', async () => {
  const db = makeDb();
  await inbox.ingestStatusBatch(db, [statusEntry(), statusEntry({ id: 'wamid.2' })]);
  const row = [...db.rows.values()][0];
  await inbox.markFailed(db, row.id, new Error('permanent'), { attempts: inbox.MAX_ATTEMPTS });

  const stats = await inbox.inboxStats(db, { now: new Date(10_000) });
  assert.equal(stats.deadLettered, 1);
  assert.equal(stats.pending, 1);
  assert.equal(stats.backlog, 1);
  assert.ok(stats.oldestPendingAgeMs > 0);
});
