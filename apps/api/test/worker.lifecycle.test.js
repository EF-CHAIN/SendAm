const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const injectMock = (relativeFromSrc, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

injectMock('config/env', {
  env: 'test',
  worker: { shutdownTimeoutMs: 1000 },
});
injectMock('config/db', async () => {});
injectMock('config/validateEnv', { validateEnv: () => {}, validateWorkerEnv: () => {} });
injectMock('common/prisma', { $disconnect: async () => {} });
injectMock('utils/logger', { info: () => {}, error: () => {} });
injectMock('jobs/index', { registerJobs: async () => ({ stop: async () => {} }) });
injectMock('queues/queue.service', { closeQueues: async () => {} });

const { startWorker } = require('../src/worker');

test('API entry point does not import or register background jobs', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/server.js'), 'utf8');
  assert.doesNotMatch(source, /registerJobs|jobs\/poller|registerProcessor/);
});

test('worker owns job startup and graceful resource shutdown', async () => {
  const calls = [];
  const runtime = await startWorker({
    connect: async () => calls.push('connect'),
    jobs: async () => {
      calls.push('jobs');
      return { stop: async () => calls.push('stop-jobs') };
    },
    closeQueueResources: async () => calls.push('close-queues'),
    disconnect: async () => calls.push('disconnect-db'),
  });
  assert.deepEqual(calls, ['connect', 'jobs']);
  await runtime.shutdown('TEST');
  assert.deepEqual(calls, ['connect', 'jobs', 'stop-jobs', 'close-queues', 'disconnect-db']);
  await runtime.shutdown('TEST_AGAIN');
  assert.equal(calls.filter((call) => call === 'stop-jobs').length, 1);
});
