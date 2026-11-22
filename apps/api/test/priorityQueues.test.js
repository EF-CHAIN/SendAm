const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PRIORITY, resolvePriority, withPriority, enqueuePrioritized } = require('../src/queues/priorityQueues');

test('priority levels follow the documented order', () => {
  assert.deepEqual(PRIORITY, { PAYMENT_SUBMISSION: 1, WEBHOOK_INTAKE: 2, RECEIPTS: 3, BULK_MESSAGING: 4 });
});

test('resolvePriority accepts class names and valid levels, rejects the rest', () => {
  assert.equal(resolvePriority('paymentSubmission'), 1);
  assert.equal(resolvePriority('bulkMessaging'), 4);
  assert.equal(resolvePriority(3), 3);
  for (const bad of ['nope', 0, 5, 1.5, null, undefined]) assert.throws(() => resolvePriority(bad));
});

test('withPriority merges without mutating the input', () => {
  const input = { jobId: 'a' };
  assert.deepEqual(withPriority('receipts', input), { jobId: 'a', priority: 3 });
  assert.deepEqual(input, { jobId: 'a' });
});

test('enqueuePrioritized forwards the priority to the enqueue function', async () => {
  const calls = [];
  const enqueue = async (...args) => { calls.push(args); return { id: '1' }; };
  await enqueuePrioritized('q', 'j', { x: 1 }, 'paymentSubmission', { jobId: 'k' }, enqueue);
  assert.deepEqual(calls[0], ['q', 'j', { x: 1 }, { jobId: 'k', priority: 1 }]);
});

// BullMQ serves prioritized jobs from a sorted set (priority ascending, then
// FIFO). This models that rule; the Redis-backed behaviour is BullMQ's own.
test('a payment job enqueued after thousands of bulk jobs is served first', () => {
  const jobs = [];
  for (let i = 0; i < 5000; i += 1) jobs.push({ id: `bulk-${i}`, priority: withPriority('bulkMessaging').priority, seq: i });
  jobs.push({ id: 'pay', priority: withPriority('paymentSubmission').priority, seq: 5000 });
  jobs.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
  assert.equal(jobs[0].id, 'pay');
});
