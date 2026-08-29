const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const injectMock = (relativeFromSrc, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

const transitions = [];
injectMock('services/whatsapp.service', { sendTextMessage: async () => {} });
injectMock('services/agent/replies', { replies: { rateLimited: () => 'slow down' } });
injectMock('services/rateLimit.service', { consume: async () => ({ totalHits: 1 }) });
injectMock('config/env', { rateLimit: { botMax: 20, botWindowMs: 60000 } });
injectMock('utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
injectMock('queues/queue.service', { enqueue: async () => { throw new Error('redis unavailable'); } });
injectMock('common/prisma', {
  processedMessage: {
    create: async () => ({}),
    updateMany: async ({ where, data }) => {
      transitions.push({ messageId: where.messageId, from: where.status, to: data.status });
      return { count: 1 };
    },
  },
});

const { handleIncomingMessage } = require('../src/controllers/webhook.controller');

test('queue failure marks the claim recoverable and returns non-2xx so Meta retries', async () => {
  const req = {
    body: {
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          value: {
            contacts: [{ profile: { name: 'Ada' } }],
            messages: [{ id: 'wamid.retry', from: '2348000000000', type: 'text', text: { body: 'balance' } }],
          },
        }],
      }],
    },
  };
  const res = {
    statusCode: null,
    body: null,
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; this.headersSent = true; return this; },
  };
  await handleIncomingMessage(req, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body, 'QUEUE_UNAVAILABLE');
  assert.deepEqual(transitions, [{ messageId: 'wamid.retry', from: 'claiming', to: 'failed' }]);
});
