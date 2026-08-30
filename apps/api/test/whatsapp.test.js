const { test } = require('node:test');
const assert = require('node:assert/strict');

// Set key to prevent startup validateEnv issues if config is loaded
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const config = require('../src/config/env');
const { sendTextMessage, cancelInFlightSends } = require('../src/services/whatsapp.service');

config.whatsapp.connectTimeoutMs = 1000;
config.whatsapp.responseTimeoutMs = 1000;
config.whatsapp.retryBaseDelayMs = 1;

test('sim mode writes the row and never calls Meta', async () => {
  const dbCalls = [];
  const fakePrisma = {
    simMessage: {
      create: async (args) => {
        dbCalls.push(args);
        return { id: 'sim_1', ...args.data };
      }
    }
  };

  const fakeAxios = {
    post: async () => {
      throw new Error('Meta API should not be called in sim mode');
    }
  };

  const result = await sendTextMessage('+12345', 'Hello from sim', {
    messageTransport: 'sim',
    prisma: fakePrisma,
    axiosImpl: fakeAxios,
  });

  assert.equal(result.outcome, 'accepted');
  assert.equal(result.data.id, 'sim_1');
  assert.equal(result.data.phoneNumber, '+12345');
  assert.equal(dbCalls.length, 1);
  assert.deepEqual(dbCalls[0], {
    data: {
      phoneNumber: '+12345',
      direction: 'out',
      text: 'Hello from sim',
    }
  });
});

test('success returns a typed accepted result and configures deadlines', async () => {
  let seenPost;
  const fakeAxios = {
    post: async (url, payload, options) => {
      seenPost = { url, payload, options };
      return { status: 200, data: { messages: [{ id: 'meta_1' }] } };
    }
  };

  const result = await sendTextMessage('+12345', 'Hello from meta', {
    messageTransport: 'meta',
    axiosImpl: fakeAxios,
  });

  assert.equal(result.outcome, 'accepted');
  assert.equal(result.providerMessageId, 'meta_1');
  assert.equal(seenPost.url.includes('/messages'), true);
  assert.equal(seenPost.payload.to, '+12345');
  assert.equal(seenPost.payload.text.body, 'Hello from meta');
  assert.equal(typeof seenPost.payload.biz_opaque_callback_data, 'string');
  assert.equal(seenPost.options.timeout, 1000);
  assert.ok(seenPost.options.signal);
});

test('429 and 5xx are retried with the same correlation id', async () => {
  config.whatsapp.maxSendRetries = 2;
  for (const status of [429, 503]) {
    const correlations = [];
    let calls = 0;
    const result = await sendTextMessage('+12345', 'retry me', {
      messageTransport: 'meta',
      correlationId: `corr-${status}`,
      sleepImpl: async () => {},
      axiosImpl: { post: async (_url, payload) => {
        correlations.push(payload.biz_opaque_callback_data);
        calls += 1;
        if (calls < 3) throw Object.assign(new Error('temporary'), { response: { status, data: {} } });
        return { status: 200, data: { messages: [{ id: `meta-${status}` }] } };
      } },
    });
    assert.equal(result.outcome, 'accepted');
    assert.equal(result.attempts, 3);
    assert.deepEqual(correlations, Array(3).fill(`corr-${status}`));
  }
});

test('4xx is permanent and is not retried', async () => {
  config.whatsapp.maxSendRetries = 2;
  let calls = 0;
  const result = await sendTextMessage('+12345', 'bad request', {
    messageTransport: 'meta',
    axiosImpl: { post: async () => {
      calls += 1;
      throw Object.assign(new Error('bad request'), { response: { status: 400, data: { error: { message: 'invalid recipient' } } } });
    } },
  });
  assert.equal(result.outcome, 'permanent_failure');
  assert.equal(result.error.status, 400);
  assert.equal(calls, 1);
});

test('malformed success response is unknown and is not retried', async () => {
  config.whatsapp.maxSendRetries = 2;
  let calls = 0;
  const result = await sendTextMessage('+12345', 'hello', {
    messageTransport: 'meta',
    axiosImpl: { post: async () => { calls += 1; return { status: 200, data: { messages: [] } }; } },
  });
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.error.kind, 'malformed_response');
  assert.equal(calls, 1);
});

test('hung request is cancelled at the configured deadline', async () => {
  config.whatsapp.connectTimeoutMs = 20;
  config.whatsapp.maxSendRetries = 0;
  const started = Date.now();
  const result = await sendTextMessage('+12345', 'hang', {
    messageTransport: 'meta',
    axiosImpl: { post: async (_url, _payload, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ERR_CANCELED' })), { once: true });
    }) },
  });
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.error.kind, 'timeout');
  assert.ok(Date.now() - started < 500);
  config.whatsapp.connectTimeoutMs = 1000;
});

test('shutdown cancels an in-flight send and preserves unknown notification state', async () => {
  const created = [];
  const pending = sendTextMessage('+12345', 'shutdown', {
    messageTransport: 'meta',
    notification: { userId: 'user-1' },
    prisma: { notification: { create: async ({ data }) => created.push(data) } },
    axiosImpl: { post: async (_url, _payload, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ERR_CANCELED' })), { once: true });
    }) },
  });
  await new Promise((resolve) => setImmediate(resolve));
  cancelInFlightSends('test shutdown');
  const result = await pending;
  assert.equal(result.error.kind, 'cancelled');
  assert.equal(created[0].status, 'unknown');
  assert.equal(created[0].failedAt, null);
});
