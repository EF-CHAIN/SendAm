/**
 * The financial idempotency invariant, asserted deterministically.
 *
 * The duplicate-storm load scenario proves the service stays responsive while
 * Meta redelivers the same message id concurrently, but a load run cannot
 * prove exactly-once — it only observes HTTP responses. This test drives the
 * real webhook controller with N simultaneous deliveries of one message id and
 * asserts that exactly one of them reaches the queue.
 *
 * The Prisma stub models the unique index the way Postgres enforces it: the
 * duplicate check and the insert happen in one synchronous step, so a second
 * caller cannot slip between them, and a duplicate raises P2002.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.NODE_ENV = 'test';

const injectMock = (relativeFromSrc, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

// --- Prisma stub: a faithful unique index on ProcessedMessage.messageId -----
const rows = new Map();
const resetRows = () => rows.clear();

injectMock('common/prisma', {
  processedMessage: {
    create: async ({ data }) => {
      // Synchronous check-and-insert: no await between them, which is what
      // makes this equivalent to the database's atomic unique-index insert.
      if (rows.has(data.messageId)) {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }
      rows.set(data.messageId, { ...data });
      return { ...data };
    },
    findUnique: async ({ where }) => (rows.has(where.messageId) ? { ...rows.get(where.messageId) } : null),
    updateMany: async ({ where, data }) => {
      const row = rows.get(where.messageId);
      if (!row) return { count: 0 };
      if (where.status && row.status !== where.status) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  },
});

// --- Everything past the dedup claim is a boundary we only need to count ---
const enqueued = [];
/**
 * Swappable so a test can simulate a Redis outage. The controller destructures
 * `enqueue` at require time, so the failure has to be injected through this
 * indirection rather than by reassigning the module export later.
 */
let enqueueFailure = null;
injectMock('queues/queue.service', {
  enqueue: async (queue, jobName, data, options) => {
    // A real enqueue awaits Redis; yielding here widens the window in which a
    // concurrent delivery could double-enqueue if the claim were not atomic.
    await new Promise((resolve) => setImmediate(resolve));
    if (enqueueFailure) {
      const error = enqueueFailure;
      enqueueFailure = null;
      throw error;
    }
    enqueued.push({ queue, jobName, data, options });
    return { id: options?.jobId || `job_${enqueued.length}` };
  },
});

const sent = [];
injectMock('services/whatsapp.service', { sendTextMessage: async (to, body) => { sent.push({ to, body }); } });
injectMock('services/agent/replies', { replies: { rateLimited: () => 'slow down' } });
injectMock('services/rateLimit.service', { consume: async () => ({ totalHits: 1 }) });
injectMock('utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
injectMock('observability/metrics', { increment: () => {} });
injectMock('observability/errors', { captureException: () => {} });

const { handleIncomingMessage } = require('../src/controllers/webhook.controller');

const payload = (messageId, from = '2348000000001', text = 'balance') => ({
  object: 'whatsapp_business_account',
  entry: [{
    changes: [{
      value: {
        messaging_product: 'whatsapp',
        contacts: [{ profile: { name: 'Load Test' } }],
        messages: [{ id: messageId, from, type: 'text', text: { body: text } }],
      },
    }],
  }],
});

/** Minimal Express-compatible response recorder. */
const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    status(code) { res.statusCode = code; return res; },
    send(body) { res.body = body; res.headersSent = true; return res; },
    sendStatus(code) { res.statusCode = code; res.headersSent = true; return res; },
  };
  return res;
};

const deliver = async (messageId) => {
  const res = makeRes();
  await handleIncomingMessage({ body: payload(messageId), get: () => undefined }, res);
  return res;
};

test('concurrent redelivery of one message id enqueues exactly once', async () => {
  resetRows();
  enqueued.length = 0;

  const CONCURRENT_DELIVERIES = 50;
  const responses = await Promise.all(
    Array.from({ length: CONCURRENT_DELIVERIES }, () => deliver('wamid.duplicate-under-load')),
  );

  assert.equal(enqueued.length, 1, 'exactly one delivery reached the queue');
  assert.equal(responses.length, CONCURRENT_DELIVERIES);

  // Every delivery is answered, and none is answered with a server error —
  // Meta must never see a 5xx here or it will mark the webhook unhealthy.
  for (const res of responses) {
    assert.ok(res.headersSent, 'every delivery got a response');
    assert.ok([200, 503].includes(res.statusCode), `unexpected status ${res.statusCode}`);
  }

  // 503 means "a concurrent request holds the claim, retry" — a deliberate,
  // retryable answer rather than a premature acknowledgement.
  const accepted = responses.filter((r) => r.statusCode === 200);
  assert.ok(accepted.length >= 1, 'at least one delivery was acknowledged');
});

test('distinct message ids under the same concurrency each enqueue exactly once', async () => {
  resetRows();
  enqueued.length = 0;

  const ids = Array.from({ length: 20 }, (_, i) => `wamid.distinct-${i}`);
  // Ten simultaneous deliveries of each id, interleaved across ids.
  const deliveries = ids.flatMap((id) => Array.from({ length: 10 }, () => id));
  await Promise.all(deliveries.map((id) => deliver(id)));

  assert.equal(enqueued.length, ids.length, 'one enqueue per distinct message id');

  const enqueuedIds = enqueued.map((job) => job.data.whatsappMessageId).sort();
  assert.deepEqual(enqueuedIds, [...ids].sort(), 'no id was dropped or duplicated');
});

test('the enqueued job carries the message id as its BullMQ job id', async () => {
  resetRows();
  enqueued.length = 0;

  await deliver('wamid.job-id-check');

  assert.equal(enqueued.length, 1);
  // A second line of defence: even if two claims ever slipped through, BullMQ
  // deduplicates on jobId, so the same message cannot produce two jobs.
  assert.equal(enqueued[0].options.jobId, 'wamid.job-id-check');
});

test('a failed delivery is left reclaimable rather than blocking the message forever', async () => {
  resetRows();
  enqueued.length = 0;

  // Force the next enqueue to fail, the way a Redis outage would.
  enqueueFailure = new Error('redis unavailable');

  const failed = await deliver('wamid.reclaimable');
  assert.equal(failed.statusCode, 503, 'the failure is reported as retryable');
  assert.equal(rows.get('wamid.reclaimable').status, 'failed');

  // Meta's next delivery reclaims the failed row and completes the work.
  const retried = await deliver('wamid.reclaimable');
  assert.equal(retried.statusCode, 200);
  assert.equal(enqueued.length, 1, 'the retry enqueued exactly once');
});
