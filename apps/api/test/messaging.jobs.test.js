const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const injectMock = (relativeFromSrc, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

injectMock('utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
injectMock('observability/metrics', { increment: () => {} });
injectMock('common/prisma', {});
injectMock('services/whatsapp.service', { recordDeliveryStatus: async () => {} });

const { startWebhookInboxDrain, startOutboxReconciler } = require('../src/jobs/messaging.jobs');
const webhookInbox = require('../src/services/webhookInbox.service');
const outbox = require('../src/services/notificationOutbox.service');

const inboxDb = () => {
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
        seq += 1;
        const row = {
          id: `e_${seq}`, provider: 'meta', status: 'pending', attempts: 0,
          nextAttemptAt: new Date(0), receivedAt: new Date(seq), processedAt: null,
          claimedAt: null, lastError: null, ...data,
        };
        rows.set(row.id, row);
        return row;
      },
      async findUnique() { return null; },
      async findMany({ where, take }) {
        const out = [...rows.values()].filter((r) => matches(r, where)).sort((a, b) => a.receivedAt - b.receivedAt);
        return take ? out.slice(0, take) : out;
      },
      async findFirst({ where }) { return (await this.findMany({ where }))[0] || null; },
      async count({ where }) { return [...rows.values()].filter((r) => matches(r, where)).length; },
      async updateMany({ where, data }) {
        let count = 0;
        for (const row of rows.values()) {
          if (!matches(row, where)) continue;
          for (const [k, v] of Object.entries(data)) row[k] = v && v.increment ? (row[k] || 0) + v.increment : v;
          count += 1;
        }
        return { count };
      },
      async update({ where, data }) { return Object.assign(rows.get(where.id), data); },
    },
  };
};

test('the inbox drain processes durable events and stops cleanly', async () => {
  const db = inboxDb();
  await webhookInbox.ingestStatusBatch(db, [{ id: 'wamid.1', status: 'delivered', timestamp: '1700000000' }]);

  const seen = [];
  const job = startWebhookInboxDrain({ intervalMs: 3_600_000, db, handler: (e) => seen.push(e.payload.id) });
  // The job runs one sweep immediately on start.
  await new Promise((resolve) => setImmediate(resolve));
  job.stop();

  assert.deepEqual(seen, ['wamid.1']);
  assert.equal([...db.rows.values()][0].status, 'processed');
});

test('a drain failure leaves the event durable for the next sweep', async () => {
  const db = inboxDb();
  await webhookInbox.ingestStatusBatch(db, [{ id: 'wamid.2', status: 'read', timestamp: '1700000001' }]);

  const job = startWebhookInboxDrain({
    intervalMs: 3_600_000,
    db,
    handler: () => { throw new Error('downstream down'); },
  });
  await new Promise((resolve) => setImmediate(resolve));
  job.stop();

  const row = [...db.rows.values()][0];
  assert.equal(row.status, 'failed');
  assert.match(row.lastError, /downstream down/);
  assert.equal(row.processedAt, null, 'must not be marked processed');
});

test('the outbox reconciler flags sends stuck mid-flight', async () => {
  const rows = new Map();
  rows.set('n_1', {
    id: 'n_1', status: 'sending', claimedAt: new Date(Date.now() - 60 * 60 * 1000),
  });
  rows.set('n_2', { id: 'n_2', status: 'sending', claimedAt: new Date() });

  const db = {
    notification: {
      async findMany({ where, take }) {
        const out = [...rows.values()].filter((r) => r.status === where.status
          && r.claimedAt < where.claimedAt.lt);
        return take ? out.slice(0, take) : out;
      },
      async updateMany({ where, data }) {
        const row = rows.get(where.id);
        if (!row || row.status !== where.status) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  };

  const job = startOutboxReconciler({ intervalMs: 3_600_000, db, olderThanMs: 5 * 60 * 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  job.stop();

  assert.equal(rows.get('n_1').status, 'unknown', 'a crashed send becomes visible');
  assert.equal(rows.get('n_2').status, 'sending', 'a fresh send is left alone');
});

test('both jobs survive a database failure without throwing', async () => {
  const broken = {
    webhookInboxEvent: { findMany: async () => { throw new Error('db down'); } },
    notification: { findMany: async () => { throw new Error('db down'); } },
  };

  const drain = startWebhookInboxDrain({ intervalMs: 3_600_000, db: broken });
  const reconciler = startOutboxReconciler({ intervalMs: 3_600_000, db: broken });
  await new Promise((resolve) => setImmediate(resolve));
  drain.stop();
  reconciler.stop();
  // Reaching here without an unhandled rejection is the assertion.
  assert.ok(true);
});

test('outbox and inbox status vocabularies stay distinct and explicit', () => {
  assert.equal(outbox.STATUS.UNKNOWN, 'unknown');
  assert.equal(webhookInbox.STATUS.DEAD_LETTER, 'dead_letter');
});
