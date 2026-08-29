/**
 * Hermetic contract test for Meta webhook batch processing.
 * No live network and no production secrets required.
 *
 * Verifies the flatting/iteration contract of handleIncomingMessage:
 *   - every supported entry, change, message and status is processed;
 *   - one malformed sibling cannot discard valid siblings;
 *   - every valid message is queued exactly once (idempotency);
 *   - a partial failure returns 503 so Meta retries, and that retry does not
 *     duplicate already accepted work.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const injectMock = (relativeFromSrc, exports) => {
  const filename = path.resolve(__dirname, '../../src', `${relativeFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

// --- Dependencies -----------------------------------------------------------
const sentText = [];
const recordedStatuses = [];

injectMock('services/whatsapp.service', {
  sendTextMessage: async (to, body) => { sentText.push({ to, body }); },
  recordDeliveryStatus: async (statusEntry) => { recordedStatuses.push(statusEntry); },
});
injectMock('services/agent/replies', { replies: { rateLimited: () => 'slow down' } });
injectMock('services/rateLimit.service', { consume: async () => ({ totalHits: 1 }) });
injectMock('config/env', { rateLimit: { botMax: 20, botWindowMs: 60000 } });
injectMock('utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
injectMock('observability/metrics', { increment: () => {} });
injectMock('observability/errors', { captureException: () => {} });

// --- Queue mock: capture every enqueue call; can be made to fail on demand --
const enqueued = [];
let enqueueShouldFailFor = null;
injectMock('queues/queue.service', {
  enqueue: async (name, jobName, data, options) => {
    if (enqueueShouldFailFor && data.whatsappMessageId === enqueueShouldFailFor) {
      throw new Error('redis unavailable');
    }
    enqueued.push({ name, jobName, data, jobId: options?.jobId });
    return { id: options?.jobId };
  },
});

// --- Prisma in-memory stub with real idempotent state transitions ----------
const state = new Map(); // messageId -> status
const prismaMock = {
  processedMessage: {
    create: async ({ data }) => {
      if (state.has(data.messageId)) {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }
      state.set(data.messageId, data.status);
      return data;
    },
    findUnique: async ({ where }) => {
      const status = state.get(where.messageId);
      return status === undefined ? null : { messageId: where.messageId, status };
    },
    updateMany: async ({ where, data }) => {
      if (state.get(where.messageId) !== where.status) return { count: 0 };
      state.set(where.messageId, data.status);
      return { count: 1 };
    },
  },
};
injectMock('common/prisma', prismaMock);

const { handleIncomingMessage } = require('../../src/controllers/webhook.controller');

// --- Helpers ----------------------------------------------------------------
const makeMessage = (id, from, type = 'text', extra = {}) => ({
  id,
  from,
  timestamp: '1700000000',
  type,
  ...(type === 'text' ? { text: { body: 'hello' } } : {}),
  ...extra,
});

const buildBody = ({ messages, statuses } = {}) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'wba_1',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            contacts: [{ profile: { name: 'Ada' }, wa_id: '2348000000000' }],
            messages: messages || [],
            statuses: statuses || [],
          },
        },
      ],
    },
  ],
});

const run = async (body) => {
  const res = { statusCode: null, body: null, headersSent: false,
    status(code) { this.statusCode = code; return this; },
    send(b) { this.body = b; this.headersSent = true; return this; } };
  await handleIncomingMessage({ body }, res);
  return res;
};

const reset = () => {
  sentText.length = 0;
  recordedStatuses.length = 0;
  enqueued.length = 0;
  enqueueShouldFailFor = null;
  state.clear();
};

const FROM = '+2348000000001';

// ---------------------------------------------------------------------------
test('processes multiple entries, changes, statuses and messages in one batch', async () => {
  reset();
  const body = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'wba_1',
        changes: [
          {
            value: {
              contacts: [{ profile: { name: 'Ada' } }],
              statuses: [
                { id: 'wamid.s1', status: 'delivered', timestamp: '1700000000' },
                { id: 'wamid.s2', status: 'read', timestamp: '1700000001' },
              ],
              messages: [
                makeMessage('wamid.m1', FROM),
                makeMessage('wamid.m2', FROM, 'audio', { audio: { id: 'audio-2' } }),
              ],
            },
          },
          {
            value: {
              contacts: [{ profile: { name: 'Ben' } }],
              messages: [
                makeMessage('wamid.m3', FROM, 'voice', { voice: { id: 'voice-3' } }),
              ],
            },
          },
        ],
      },
      {
        id: 'wba_2',
        changes: [
          {
            value: {
              contacts: [{ profile: { name: 'Cara' } }],
              statuses: [
                { id: 'wamid.s3', status: 'sent', timestamp: '1700000002' },
              ],
              messages: [
                makeMessage('wamid.m4', FROM),
              ],
            },
          },
        ],
      },
    ],
  };

  const res = await run(body);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'EVENT_RECEIVED');

  // All 4 messages queued, exactly once, in encounter order.
  assert.equal(enqueued.length, 4);
  assert.deepEqual(
    enqueued.map((e) => e.data.whatsappMessageId),
    ['wamid.m1', 'wamid.m2', 'wamid.m3', 'wamid.m4'],
  );
  // jobId idempotency key is preserved per message.
  assert.deepEqual(enqueued.map((e) => e.jobId), ['wamid.m1', 'wamid.m2', 'wamid.m3', 'wamid.m4']);
  // Media id mapping.
  assert.equal(enqueued[1].data.mediaId, 'audio-2');
  assert.equal(enqueued[2].data.mediaId, 'voice-3');
  // All 3 statuses recorded.
  assert.deepEqual(recordedStatuses.map((s) => s.id), ['wamid.s1', 'wamid.s2', 'wamid.s3']);
});

// ---------------------------------------------------------------------------
test('malformed and unsupported sibling items are skipped without discarding valid ones', async () => {
  reset();
  const body = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ profile: { name: 'X' } }],
              statuses: [
                { id: '', status: 'delivered', timestamp: '1' },   // malformed status
                { id: 'wamid.ok-status', status: 'delivered', timestamp: '1' },
              ],
              messages: [
                { id: 'wamid.bad-missing-from', type: 'text', text: { body: 'x' } }, // malformed message
                makeMessage('wamid.m1', FROM),                                        // valid
                makeMessage('wamid.m2', FROM, 'image', { image: { id: 'i' } }),       // unsupported type
                makeMessage('wamid.m3', FROM),                                        // valid
              ],
            },
          },
        ],
      },
    ],
  };

  const res = await run(body);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'EVENT_RECEIVED');

  // Only the two valid messages were enqueued; malformed/unsupported skipped.
  assert.deepEqual(enqueued.map((e) => e.data.whatsappMessageId), ['wamid.m1', 'wamid.m3']);
  // Only the valid status was recorded.
  assert.deepEqual(recordedStatuses.map((s) => s.id), ['wamid.ok-status']);
});

// ---------------------------------------------------------------------------
test('partial failure returns 503 and a retry does not duplicate accepted work', async () => {
  reset();
  enqueueShouldFailFor = 'wamid.m2';
  const body = buildBody({ messages: [
    makeMessage('wamid.m1', FROM),
    makeMessage('wamid.m2', FROM),
    makeMessage('wamid.m3', FROM),
  ] });

  // First delivery: m1, m3 succeed; m2 fails -> 503 so Meta retries.
  const res1 = await run(body);
  assert.equal(res1.statusCode, 503);
  assert.equal(res1.body, 'QUEUE_UNAVAILABLE');
  assert.deepEqual(enqueued.map((e) => e.data.whatsappMessageId), ['wamid.m1', 'wamid.m3']);
  assert.equal(state.get('wamid.m2'), 'failed', 'failed message is left reclaimable');

  // Meta retry of the same batch. Queue is healthy again.
  enqueueShouldFailFor = null;
  const res2 = await run(body);
  assert.equal(res2.statusCode, 200);

  // Already-accepted messages were deduped; only the failed one is reclaimed
  // and enqueued. Nothing was queued twice.
  assert.deepEqual(enqueued.map((e) => e.data.whatsappMessageId), ['wamid.m1', 'wamid.m3', 'wamid.m2']);
  assert.equal(state.get('wamid.m1'), 'queued');
  assert.equal(state.get('wamid.m2'), 'queued');
  assert.equal(state.get('wamid.m3'), 'queued');
});

// ---------------------------------------------------------------------------
test('duplicate message id within the same batch is queued once', async () => {
  reset();
  const body = buildBody({ messages: [
    makeMessage('wamid.dup', FROM),
    makeMessage('wamid.dup', FROM),
    makeMessage('wamid.other', FROM),
  ] });

  const res = await run(body);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(enqueued.map((e) => e.data.whatsappMessageId), ['wamid.dup', 'wamid.other']);
});

// ---------------------------------------------------------------------------
test('claiming conflict on one message returns retryable 503 without dropping other work', async () => {
  reset();
  // Pre-seed a 'claiming' row for the first message to simulate a concurrent
  // request that is still in flight; it must yield a retryable response.
  state.set('wamid.concurrent', 'claiming');
  const body = buildBody({ messages: [
    makeMessage('wamid.concurrent', FROM),
    makeMessage('wamid.done', FROM),
  ] });

  const res = await run(body);
  assert.equal(res.statusCode, 503);
  // The non-conflicting sibling was still processed.
  assert.deepEqual(enqueued.map((e) => e.data.whatsappMessageId), ['wamid.done']);
});
