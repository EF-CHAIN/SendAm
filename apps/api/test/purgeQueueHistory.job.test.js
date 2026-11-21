const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  purgeQueueHistory,
  retentionMsFromEnv,
  startQueueHistoryPurge,
} = require('../src/jobs/purgeQueueHistory.job');

const DAY_MS = 24 * 60 * 60 * 1000;

const fakeQueue = (backlog = {}) => {
  const calls = [];
  const remaining = { completed: 0, failed: 0, ...backlog };
  return {
    calls,
    clean: async (grace, limit, status) => {
      calls.push({ grace, limit, status });
      const n = Math.min(limit, remaining[status]);
      remaining[status] -= n;
      return Array.from({ length: n }, (_, i) => String(i));
    },
  };
};

test('retention defaults to 7 days and honours QUEUE_HISTORY_RETENTION_DAYS', () => {
  assert.equal(retentionMsFromEnv({}), 7 * DAY_MS);
  assert.equal(retentionMsFromEnv({ QUEUE_HISTORY_RETENTION_DAYS: '2' }), 2 * DAY_MS);
  assert.equal(retentionMsFromEnv({ QUEUE_HISTORY_RETENTION_DAYS: 'abc' }), 7 * DAY_MS);
  assert.equal(retentionMsFromEnv({ QUEUE_HISTORY_RETENTION_DAYS: '-1' }), 7 * DAY_MS);
});

test('cleans completed and failed jobs older than 7 days on every queue', async () => {
  const a = fakeQueue({ completed: 3, failed: 2 });
  const b = fakeQueue();
  const report = await purgeQueueHistory({ queues: { a, b }, batchSize: 100 });

  assert.equal(report.totalRemoved, 5);
  assert.equal(report.failures, 0);
  for (const queue of [a, b]) {
    assert.deepEqual(queue.calls.map((c) => c.status), ['completed', 'failed']);
    assert.ok(queue.calls.every((c) => c.grace === 7 * DAY_MS));
  }
});

test('drains large backlogs in bounded batches', async () => {
  const queue = fakeQueue({ completed: 2500 });
  const report = await purgeQueueHistory({ queues: { q: queue }, batchSize: 1000 });

  const completedCalls = queue.calls.filter((c) => c.status === 'completed');
  assert.equal(completedCalls.length, 3);
  assert.ok(completedCalls.every((c) => c.limit === 1000));
  assert.equal(report.totalRemoved, 2500);
});

test('stops after maxBatches so one sweep cannot run unbounded', async () => {
  const queue = fakeQueue({ completed: 10000 });
  const report = await purgeQueueHistory({ queues: { q: queue }, batchSize: 10, maxBatches: 3 });
  assert.equal(queue.calls.filter((c) => c.status === 'completed').length, 3);
  assert.equal(report.totalRemoved, 30);
});

test('a failing queue is reported and does not stop other queues', async () => {
  const broken = { clean: async () => { throw new Error('redis down'); } };
  const healthy = fakeQueue({ completed: 1 });
  const report = await purgeQueueHistory({ queues: { broken, healthy } });

  assert.equal(report.failures, 2);
  assert.equal(report.totalRemoved, 1);
  assert.match(report.results.find((r) => r.queue === 'broken').error, /redis down/);
});

test('skips entries that are not queues', async () => {
  const report = await purgeQueueHistory({ queues: { none: null, bad: {} } });
  assert.deepEqual(report.results, []);
});

test('scheduler runs on demand and stop() is safe', async () => {
  const queue = fakeQueue({ failed: 1 });
  const handle = startQueueHistoryPurge({
    intervalMs: 60 * 60 * 1000,
    initialDelayMs: 60 * 60 * 1000,
    resolveQueues: () => ({ q: queue }),
  });
  const report = await handle.run();
  assert.equal(report.totalRemoved, 1);
  handle.stop();
});

test('scheduler survives a resolver failure', async () => {
  const handle = startQueueHistoryPurge({
    intervalMs: 60 * 60 * 1000,
    initialDelayMs: 60 * 60 * 1000,
    resolveQueues: () => { throw new Error('no redis'); },
  });
  assert.equal(await handle.run(), null);
  handle.stop();
});
