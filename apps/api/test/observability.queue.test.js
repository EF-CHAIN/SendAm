const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runWithContext, getContext } = require('../src/observability/context');

const filename = path.resolve(__dirname, '../src/config/env.js');
require.cache[filename] = {
  id: filename,
  filename,
  loaded: true,
  exports: { redis: { url: undefined } },
};

const { registerProcessor, enqueue } = require('../src/queues/queue.service');

test('queue propagation preserves request correlation in worker context', async () => {
  let observed;
  registerProcessor('correlation-test', async (job) => {
    observed = { context: getContext(), data: job.data };
  });
  await runWithContext({ correlationId: 'request-to-worker-1' }, () => (
    enqueue('correlation-test', 'test.job', { amount: '5' }, { jobId: 'job-1' })
  ));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observed.context.correlationId, 'request-to-worker-1');
  assert.equal(observed.context.jobId, 'job-1');
  assert.equal(observed.data.correlationId, 'request-to-worker-1');
});
