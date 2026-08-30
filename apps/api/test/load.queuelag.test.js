/**
 * Queue lag sampling.
 *
 * The no-Redis path is asserted unconditionally, because reporting an
 * unobserved queue as an empty one is the failure mode that would quietly
 * certify a service with an unbounded backlog.
 *
 * The live path needs a real Redis, so it runs only when `REDIS_URL` is set —
 * see docs/LOAD-TESTING.md for bringing one up. It is skipped rather than
 * mocked because the thing worth testing here is the BullMQ API contract
 * (`getJobCounts`, `getJobs` ordering), which a mock would only restate.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sampleQueueLag, QUEUE_NAMES } = require('../load/lib/queueLag');

const REDIS_URL = process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL;

test('reports not-measured, with a reason, when no Redis is configured', async () => {
  const result = await sampleQueueLag({ redisUrl: undefined });
  assert.equal(result.measured, false);
  assert.match(result.reason, /REDIS_URL/);
  // Crucially not zero: an unobserved queue must never read as an empty one.
  assert.equal(result.depth, undefined);
});

test('an unreachable Redis reports not-measured rather than throwing', async () => {
  // A load run must not die because the queue sampler could not connect.
  const result = await sampleQueueLag({ redisUrl: 'redis://127.0.0.1:1' });
  assert.equal(result.measured, false);
  assert.ok(result.reason);
});

test('default queue names are the ones the app actually registers', () => {
  assert.ok(QUEUE_NAMES.includes('whatsapp-messages'));
  assert.ok(QUEUE_NAMES.length > 0);
});

test('measures depth and oldest-job age against a live BullMQ queue', { skip: !REDIS_URL && 'REDIS_URL not set' }, async () => {
  const { Queue } = require('bullmq');
  const IORedis = require('ioredis');

  const queueName = `load-test-lag-${process.pid}`;
  const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue(queueName, { connection });

  try {
    await queue.drain(true);

    const empty = await sampleQueueLag({ redisUrl: REDIS_URL, queueNames: [queueName] });
    assert.equal(empty.measured, true);
    assert.equal(empty.depth, 0);
    assert.equal(empty.oldestJobAgeMs, 0);

    // No worker is attached, so these stay waiting and become real backlog.
    for (let i = 0; i < 5; i += 1) {
      await queue.add('lag-probe', { i });
    }

    const backlog = await sampleQueueLag({ redisUrl: REDIS_URL, queueNames: [queueName] });
    assert.equal(backlog.measured, true);
    assert.equal(backlog.depth, 5, 'counts waiting jobs');
    assert.ok(backlog.oldestJobAgeMs >= 0, 'ages the oldest waiting job');
  } finally {
    await queue.drain(true).catch(() => {});
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close().catch(() => {});
    await connection.quit().catch(() => {});
  }
});
