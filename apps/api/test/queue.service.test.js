const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const injectMock = (relativeFromSrc, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

injectMock('config/env', {
  redis: { url: undefined },
  worker: { concurrency: 2, lockDurationMs: 30000 },
});
injectMock('utils/logger', { info: () => {}, warn: () => {}, error: () => {} });

const { enqueue, registerProcessor, closeQueues } = require('../src/queues/queue.service');

test('fails closed instead of silently losing a job when no queue or inline processor exists', async () => {
  await assert.rejects(
    () => enqueue('missing', 'job', { value: 1 }),
    /Queue "missing" is unavailable/,
  );
});

test('keeps explicit inline processing available for tests and local harnesses', async () => {
  let received;
  registerProcessor('inline-test', async (job) => { received = job; });
  const result = await enqueue('inline-test', 'message.received', { value: 42 }, { jobId: 'message-1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.id, 'message-1');
  assert.equal(received.name, 'message.received');
  assert.equal(received.data.value, 42);
  await closeQueues();
});
