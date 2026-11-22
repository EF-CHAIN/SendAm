'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const injectMock = (relativeFromSrc, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

injectMock('utils/logger', { info: () => {}, warn: () => {}, error: () => {} });

const config = require('../src/config/env');
const dlq = require('../src/queues/dlq.service');
const manager = require('../src/queues/dlqManager');

const makeJob = (id = 'job-1') => ({
  id,
  name: 'processInboundMessage',
  attemptsMade: 3,
  data: { from: '+2348011112222', whatsappMessageId: `wamid.${id}`, pin: '1234' },
});

const withWebhook = (url) => {
  config.observability = { ...(config.observability || {}), dlqAlertWebhookUrl: url, errorMonitorWebhookUrl: undefined };
};

beforeEach(async () => {
  await dlq.clearDlq();
  manager.resetHandledJobs();
  withWebhook(undefined);
});

test('detectWebhookKind distinguishes Discord, Slack and generic endpoints', () => {
  assert.equal(manager.detectWebhookKind('https://discord.com/api/webhooks/1/abc'), 'discord');
  assert.equal(manager.detectWebhookKind('https://hooks.slack.com/services/T/B/x'), 'slack');
  assert.equal(manager.detectWebhookKind('https://alerts.example.com/hook'), 'generic');
});

test('exhausted job is stored in the DLQ and an alert with the stack trace is sent', async () => {
  withWebhook('https://hooks.slack.com/services/T/B/x');
  const posts = [];
  const error = new Error('Horizon 503 Service Unavailable');
  const { record, alert } = await manager.handleExhaustedJob(makeJob(), error, {
    queueName: 'whatsapp-inbound',
    post: async (url, body) => { posts.push({ url, body }); },
  });

  assert.equal(record.status, 'pending');
  assert.match(record.failureStack, /Horizon 503 Service Unavailable/);
  assert.equal(alert.sent, true);
  assert.equal(posts.length, 1);
  const { text } = posts[0].body;
  assert.match(text, new RegExp(record.id));
  assert.match(text, /Horizon 503/);
  assert.match(text, /at .*dlqManager\.test\.js/, 'stack trace is included');
  assert.match(text, /whatsapp-dlq\.js replay/, 'requeue command is included');
  assert.ok(!text.includes('1234') && !text.includes('2348011112222'), 'payload / PII never leaves the process');
});

test('Discord alerts use the content field and respect the 2000 char limit', async () => {
  withWebhook('https://discord.com/api/webhooks/1/abc');
  const error = new Error('x');
  error.stack = `Error: x\n${'    at somewhere (file.js:1:1)\n'.repeat(500)}`;
  const posts = [];
  await manager.handleExhaustedJob(makeJob('d1'), error, { post: async (u, b) => { posts.push(b); } });
  assert.ok(typeof posts[0].content === 'string');
  assert.ok(posts[0].content.length <= 2000);
});

test('the same exhausted job reported twice is stored and alerted once', async () => {
  withWebhook('https://alerts.example.com/hook');
  let posts = 0;
  const post = async () => { posts += 1; };
  const first = await manager.handleExhaustedJob(makeJob('dup'), new Error('boom'), { post });
  const second = await manager.handleExhaustedJob(makeJob('dup'), new Error('boom'), { post });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(posts, 1);
  assert.equal((await dlq.listDeadLetterJobs({ status: 'pending' })).length, 1);
});

test('a failing webhook never throws and the job is still dead-lettered', async () => {
  withWebhook('https://alerts.example.com/hook');
  const { record, alert } = await manager.handleExhaustedJob(makeJob('f1'), new Error('boom'), {
    post: async () => { throw new Error('webhook down'); },
  });
  assert.equal(alert.sent, false);
  assert.equal(alert.reason, 'delivery_failed');
  assert.ok(await dlq.getDeadLetterJob(record.id));
});

test('no webhook configured skips the alert without error', async () => {
  const { alert } = await manager.handleExhaustedJob(makeJob('n1'), new Error('boom'), {});
  assert.deepEqual(alert, { sent: false, reason: 'no_webhook_configured' });
});

test('inspectJob omits the raw payload and keeps the sanitized one', async () => {
  const { record } = await manager.handleExhaustedJob(makeJob('i1'), new Error('boom'), {});
  const view = await manager.inspectJob(record.id);
  assert.equal(view.rawPayload, undefined);
  assert.equal(view.payload.pin, '[REDACTED]');
  assert.equal(await manager.inspectJob('missing'), null);
});

test('requeueJob re-enqueues the original payload and marks the record replayed', async () => {
  const { record } = await manager.handleExhaustedJob(makeJob('r1'), new Error('boom'), {});
  const enqueued = [];
  const queueService = { enqueue: async (...args) => { enqueued.push(args); } };

  const result = await manager.requeueJob(record.id, { queueService, actorId: 'admin-1' });
  assert.equal(result.replayed, true);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0][0], 'whatsapp-inbound');
  assert.equal(enqueued[0][2].pin, '1234', 'replay uses the unredacted original payload');
  assert.equal(enqueued[0][2].isReplay, true);

  const again = await manager.requeueJob(record.id, { queueService });
  assert.equal(again.replayed, false, 'a second requeue is a no-op');
  assert.equal(enqueued.length, 1);
});

test('requeueAllPending replays each pending job once and reports a summary', async () => {
  for (const id of ['a', 'b', 'c']) await manager.handleExhaustedJob(makeJob(id), new Error('boom'), {});
  const enqueued = [];
  const queueService = { enqueue: async (...args) => { enqueued.push(args); } };
  const summary = await manager.requeueAllPending({ queueService });
  assert.deepEqual(summary, { total: 3, replayed: 3, skipped: 0, failed: 0 });
  assert.equal(enqueued.length, 3);
  assert.deepEqual(await manager.requeueAllPending({ queueService }), { total: 0, replayed: 0, skipped: 0, failed: 0 });
});
