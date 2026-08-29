const { test } = require('node:test');
const assert = require('node:assert/strict');

test('drains an active BullMQ job before closing queue resources', {
  skip: !process.env.REDIS_URL || process.env.RUN_REDIS_INTEGRATION !== 'true',
}, async () => {
  const { enqueue, registerProcessor, closeQueues } = require('../src/queues/queue.service');
  const queueName = `shutdown-integration-${Date.now()}`;
  let active = false;
  let release;
  const running = new Promise((resolve) => { release = resolve; });

  registerProcessor(queueName, async () => {
    active = true;
    await running;
  });

  const job = await enqueue(queueName, 'long-running', {});
  for (let attempt = 0; attempt < 20 && !active; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(active, true);

  const closing = closeQueues();
  release();
  await closing;
  assert.equal(active, true);
  assert.ok(job.id);
});