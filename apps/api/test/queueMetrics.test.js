const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  collectBullmqMetrics, createQueueMetricsHandler, parseUsedMemory,
} = require('../src/observability/queueMetrics');
const { renderMetrics, resetMetrics } = require('../src/observability/metrics');

beforeEach(() => {
  resetMetrics();
  process.env.METRICS_TOKEN = 'tok';
});

const fakeQueue = (counts) => ({ getJobCounts: async () => counts });

test('collect exports waiting (incl. prioritized), active and redis memory gauges', async () => {
  const queues = { a: fakeQueue({ waiting: 3, prioritized: 2, active: 1 }), b: fakeQueue({ waiting: 0, active: 4 }) };
  await collectBullmqMetrics({
    queueNames: ['a', 'b', 'missing'],
    getQueueHandle: (n) => queues[n] || null,
    getRegisteredProcessors: () => [],
    getRedisInfo: async () => '# Memory\r\nused_memory:1048576\r\n',
  });
  const out = renderMetrics();
  assert.match(out, /# TYPE bullmq_waiting_jobs_count gauge/);
  assert.match(out, /bullmq_waiting_jobs_count\{queue="a"\} 5/);
  assert.match(out, /bullmq_active_jobs_count\{queue="b"\} 4/);
  assert.match(out, /bullmq_redis_memory_used_bytes 1048576/);
});

test('one failing queue does not blank the others', async () => {
  const bad = { getJobCounts: async () => { throw new Error('boom'); } };
  const result = await collectBullmqMetrics({
    queueNames: ['bad', 'ok'],
    getQueueHandle: (n) => (n === 'bad' ? bad : fakeQueue({ waiting: 7, active: 0 })),
    getRegisteredProcessors: () => [],
    getRedisInfo: async () => null,
  });
  assert.equal(result.errors.length, 1);
  assert.match(renderMetrics(), /bullmq_waiting_jobs_count\{queue="ok"\} 7/);
});

test('parseUsedMemory handles absent data', () => {
  assert.equal(parseUsedMemory('used_memory:42\n'), 42);
  assert.equal(parseUsedMemory(null), null);
});

const call = async (handler, authorization) => {
  const res = {
    status: null,
    body: null,
    sendStatus(c) { this.status = c; },
    type() { return this; },
    send(b) { this.status = 200; this.body = b; },
  };
  await handler({ get: () => authorization }, res);
  return res;
};

test('handler refuses unauthenticated scrapes without touching Redis', async () => {
  let collected = false;
  const handler = createQueueMetricsHandler({ collect: async () => { collected = true; } });
  assert.equal((await call(handler, 'Bearer wrong')).status, 403);
  assert.equal(collected, false);
});

test('handler refreshes then serves, and survives a failing or slow collector', async () => {
  let collected = false;
  const ok = await call(createQueueMetricsHandler({ collect: async () => { collected = true; } }), 'Bearer tok');
  assert.equal(ok.status, 200);
  assert.ok(collected);
  const failing = await call(createQueueMetricsHandler({ collect: async () => { throw new Error('redis down'); } }), 'Bearer tok');
  assert.equal(failing.status, 200);
  const slow = await call(createQueueMetricsHandler({ timeoutMs: 20, collect: () => new Promise(() => {}) }), 'Bearer tok');
  assert.equal(slow.status, 200);
});
