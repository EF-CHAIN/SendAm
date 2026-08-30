const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const injectMock = (relativeFromSrc, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

injectMock('utils/logger', { info: () => {}, warn: () => {}, error: () => {} });

const {
  createInMemoryOrderingStore,
  evaluateOrdering,
  withOrdering,
} = require('../src/queues/ordering.service');

// ---- evaluateOrdering: pure decision function -----------------------------

test('evaluateOrdering lets the first message for a sender through', async () => {
  const store = createInMemoryOrderingStore();
  const decision = await evaluateOrdering(store, '+123', 1000, 'msg-1');
  assert.equal(decision.action, 'process');
});

test('evaluateOrdering requeues a second message while the first sender lock is held', async () => {
  const store = createInMemoryOrderingStore();
  const first = await evaluateOrdering(store, '+123', 1000, 'msg-1');
  assert.equal(first.action, 'process');
  // Lock for +123 is now held (evaluateOrdering itself calls tryAcquire).
  const second = await evaluateOrdering(store, '+123', 1001, 'msg-2');
  assert.equal(second.action, 'requeue');
});

test('evaluateOrdering does not requeue messages from a different sender', async () => {
  const store = createInMemoryOrderingStore();
  const first = await evaluateOrdering(store, '+123', 1000, 'msg-1');
  assert.equal(first.action, 'process');
  const second = await evaluateOrdering(store, '+456', 1000, 'msg-2');
  assert.equal(second.action, 'process');
});

test('evaluateOrdering marks a message older than the cursor as stale', async () => {
  const store = createInMemoryOrderingStore();
  store.advanceCursor('+123', { timestamp: 5000, messageId: 'later' });
  const decision = await evaluateOrdering(store, '+123', 4000, 'earlier');
  assert.equal(decision.action, 'stale');
  assert.equal(decision.reason, 'older-than-cursor');
});

test('evaluateOrdering marks an exact duplicate as stale', async () => {
  const store = createInMemoryOrderingStore();
  store.advanceCursor('+123', { timestamp: 5000, messageId: 'dup' });
  const decision = await evaluateOrdering(store, '+123', 5000, 'dup');
  assert.equal(decision.action, 'stale');
  assert.equal(decision.reason, 'duplicate');
});

test('advanceCursor refuses to move the cursor backwards', () => {
  const store = createInMemoryOrderingStore();
  assert.equal(store.advanceCursor('+123', { timestamp: 5000, messageId: 'b' }), true);
  assert.equal(store.advanceCursor('+123', { timestamp: 4000, messageId: 'a' }), false);
  assert.deepEqual(store.getCursor('+123'), { timestamp: 5000, messageId: 'b' });
});

// ---- withOrdering: end-to-end processor wrapping ---------------------------

const buildJob = ({ id, from, providerTimestamp, whatsappMessageId }) => ({
  id,
  data: { from, providerTimestamp, whatsappMessageId },
  timestamp: providerTimestamp,
});

test('withOrdering processes same-sender jobs strictly in order, one at a time', async () => {
  const store = createInMemoryOrderingStore();
  const processedOrder = [];
  const releases = new Map();

  const processor = async (job) => new Promise((resolve) => {
    releases.set(job.id, () => {
      processedOrder.push(job.id);
      resolve(`done-${job.id}`);
    });
  });

  const ordered = withOrdering(processor, { store, requeueDelayMs: 5 });

  const jobA = buildJob({ id: 'a', from: '+123', providerTimestamp: 1000, whatsappMessageId: 'a' });
  const jobB = buildJob({ id: 'b', from: '+123', providerTimestamp: 2000, whatsappMessageId: 'b' });

  const pendingA = ordered(jobA);
  // Give the requeue loop a moment to observe the lock is held before B's
  // processor could possibly run.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const pendingB = ordered(jobB);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(processedOrder.length, 0, 'neither job should complete until released');

  releases.get('a')();
  await pendingA;

  // B's requeue loop polls every requeueDelayMs; wait for it to notice the
  // now-freed lock and actually invoke the processor before releasing it.
  const deadline = Date.now() + 2000;
  while (!releases.has('b')) {
    if (Date.now() > deadline) throw new Error('timed out waiting for job b to start processing');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  releases.get('b')();
  await pendingB;

  assert.deepEqual(processedOrder, ['a', 'b']);
});

test('withOrdering lets different senders run without waiting on each other', async () => {
  const store = createInMemoryOrderingStore();
  let concurrentCount = 0;
  let maxConcurrent = 0;

  const processor = async () => {
    concurrentCount += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrentCount);
    await new Promise((resolve) => setTimeout(resolve, 20));
    concurrentCount -= 1;
    return 'ok';
  };

  const ordered = withOrdering(processor, { store, requeueDelayMs: 5 });

  const jobA = buildJob({ id: 'a', from: '+123', providerTimestamp: 1000, whatsappMessageId: 'a' });
  const jobB = buildJob({ id: 'b', from: '+456', providerTimestamp: 1000, whatsappMessageId: 'b' });

  await Promise.all([ordered(jobA), ordered(jobB)]);
  assert.equal(maxConcurrent, 2);
});

test('withOrdering drops a stale redelivery instead of reprocessing it', async () => {
  const store = createInMemoryOrderingStore();
  const seen = [];
  const processor = async (job) => { seen.push(job.id); return 'ok'; };
  const ordered = withOrdering(processor, { store, requeueDelayMs: 5 });

  const confirm = buildJob({ id: 'confirm', from: '+123', providerTimestamp: 2000, whatsappMessageId: 'confirm' });
  const cancel = buildJob({ id: 'cancel', from: '+123', providerTimestamp: 3000, whatsappMessageId: 'cancel' });
  // A late redelivery of the already-superseded "confirm" event — it must
  // not reprocess and reverse the newer "cancel" that already applied.
  const staleReplay = buildJob({ id: 'confirm', from: '+123', providerTimestamp: 2000, whatsappMessageId: 'confirm' });
  // An exact duplicate of the newest applied event (e.g. a webhook retry).
  const exactDuplicate = buildJob({ id: 'cancel', from: '+123', providerTimestamp: 3000, whatsappMessageId: 'cancel' });

  await ordered(confirm);
  await ordered(cancel);
  const replayResult = await ordered(staleReplay);
  const duplicateResult = await ordered(exactDuplicate);

  assert.deepEqual(seen, ['confirm', 'cancel']);
  assert.equal(replayResult.skipped, true);
  assert.equal(replayResult.reason, 'older-than-cursor');
  assert.equal(duplicateResult.skipped, true);
  assert.equal(duplicateResult.reason, 'duplicate');
});

test('withOrdering releases the sender lock even when the processor throws, so later messages are not wedged', async () => {
  const store = createInMemoryOrderingStore();
  const processor = async (job) => {
    if (job.id === 'boom') throw new Error('processing failed');
    return 'ok';
  };
  const ordered = withOrdering(processor, { store, requeueDelayMs: 5 });

  const failing = buildJob({ id: 'boom', from: '+123', providerTimestamp: 1000, whatsappMessageId: 'boom' });
  const next = buildJob({ id: 'next', from: '+123', providerTimestamp: 2000, whatsappMessageId: 'next' });

  await assert.rejects(() => ordered(failing), /processing failed/);
  const result = await ordered(next);
  assert.equal(result, 'ok');
});

test('withOrdering fails open (processes immediately) when a job has no sender to key on', async () => {
  const store = createInMemoryOrderingStore();
  let calls = 0;
  const processor = async () => { calls += 1; return 'ok'; };
  const ordered = withOrdering(processor, { store, requeueDelayMs: 5 });

  const job = { id: 'no-sender', data: {}, timestamp: 1000 };
  const result = await ordered(job);
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

// ---- Distributed / Redis ordering store tests ------------------------------

const { createRedisOrderingStore, createDistributedOrderingStore } = require('../src/queues/ordering.service');

const createMockRedis = () => {
  const data = new Map();
  const ttls = new Map();

  return {
    async set(key, value, mode1, pxMs, mode2) {
      if (mode2 === 'NX' && data.has(key)) {
        return null;
      }
      data.set(key, String(value));
      if (pxMs) {
        ttls.set(key, Date.now() + pxMs);
      }
      return 'OK';
    },
    async get(key) {
      const exp = ttls.get(key);
      if (exp && Date.now() > exp) {
        data.delete(key);
        ttls.delete(key);
        return null;
      }
      return data.get(key) || null;
    },
    async del(...keys) {
      let count = 0;
      for (const k of keys) {
        if (data.delete(k)) count++;
        ttls.delete(k);
      }
      return count;
    },
    async keys(pattern) {
      const prefix = pattern.replace('*', '');
      return Array.from(data.keys()).filter((k) => k.startsWith(prefix));
    },
    async eval(script, numKeys, key, ...args) {
      if (script.includes('del')) {
        // Safe release script: if get(key) == ownerId then del(key)
        const val = data.get(key);
        if (val === args[0]) {
          data.delete(key);
          ttls.delete(key);
          return 1;
        }
        return 0;
      }
      if (script.includes('cjson.decode') || script.includes('newTs')) {
        // Atomic cursor CAS script: compare timestamp & messageId
        const currentRaw = data.get(key);
        const newTs = Number(args[0]);
        const newId = args[1];

        if (currentRaw) {
          const current = JSON.parse(currentRaw);
          if (current.timestamp > newTs) return 0;
          if (current.timestamp === newTs && current.messageId === newId) return 0;
        }
        data.set(key, JSON.stringify({ timestamp: newTs, messageId: newId }));
        return 1;
      }
      return 0;
    },
    _forceExpire(key) {
      data.delete(key);
      ttls.delete(key);
    },
  };
};

test('createRedisOrderingStore handles lock ownership and safe release across replicas', async () => {
  const mockRedis = createMockRedis();
  const storeA = createRedisOrderingStore({ redis: mockRedis, lockTtlMs: 1000 });
  const storeB = createRedisOrderingStore({ redis: mockRedis, lockTtlMs: 1000 });

  const sender = '+2348000000001';
  const ownerA = 'replica-worker-A';
  const ownerB = 'replica-worker-B';

  // Worker A acquires lock
  assert.equal(await storeA.tryAcquire(sender, ownerA), true);
  // Worker B attempts lock for same sender -> refused
  assert.equal(await storeB.tryAcquire(sender, ownerB), false);

  // Worker B attempts to release Worker A's lock -> denied (does not unlock Worker A)
  await storeB.release(sender, ownerB);
  assert.equal(await storeB.tryAcquire(sender, ownerB), false);

  // Worker A releases lock -> succeeded
  await storeA.release(sender, ownerA);
  // Worker B can now acquire lock
  assert.equal(await storeB.tryAcquire(sender, ownerB), true);
});

test('createRedisOrderingStore recovers from a crashed worker via lock TTL expiration', async () => {
  const mockRedis = createMockRedis();
  const store = createRedisOrderingStore({ redis: mockRedis, lockTtlMs: 100 });

  const sender = '+2348000000002';
  assert.equal(await store.tryAcquire(sender, 'worker-crash'), true);
  assert.equal(await store.tryAcquire(sender, 'worker-new'), false);

  // Simulating crash: worker never calls release(), TTL expires on Redis
  mockRedis._forceExpire(`whatsapp:ordering:lock:${sender}`);

  // New worker replica takes over lock cleanly
  assert.equal(await store.tryAcquire(sender, 'worker-new'), true);
});

test('createRedisOrderingStore provides atomic cursor CAS across restarts', async () => {
  const mockRedis = createMockRedis();
  const store1 = createRedisOrderingStore({ redis: mockRedis });

  const sender = '+2348000000003';
  assert.equal(await store1.advanceCursor(sender, { timestamp: 5000, messageId: 'msg-1' }), true);

  // Restart / new instance reads cursor from Redis
  const store2 = createRedisOrderingStore({ redis: mockRedis });
  assert.deepEqual(await store2.getCursor(sender), { timestamp: 5000, messageId: 'msg-1' });

  // Older message rejected
  assert.equal(await store2.advanceCursor(sender, { timestamp: 4000, messageId: 'msg-old' }), false);
  // Duplicate message rejected
  assert.equal(await store2.advanceCursor(sender, { timestamp: 5000, messageId: 'msg-1' }), false);
  // Newer message accepted
  assert.equal(await store2.advanceCursor(sender, { timestamp: 6000, messageId: 'msg-2' }), true);
  assert.deepEqual(await store2.getCursor(sender), { timestamp: 6000, messageId: 'msg-2' });
});

test('createDistributedOrderingStore creates in-memory fallback when REDIS_URL is absent', () => {
  const store = createDistributedOrderingStore();
  assert.ok(store);
  assert.equal(typeof store.tryAcquire, 'function');
});

