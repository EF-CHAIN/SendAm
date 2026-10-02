const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

// Route-level coverage for sim.routes.js (#435). The router is mounted over
// HTTP behind the chat-sim feature gate, with the real sim controller and
// request validation. Only the assistant pipeline is stubbed, so no Prisma or
// WhatsApp dependency is loaded.
const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

const pipelineCalls = [];
inject('whatsapp/assistant.service', {
  processMessage: async (phoneNumber, name, text, { notify }) => {
    pipelineCalls.push({ phoneNumber, name, text });
    await notify(phoneNumber, `Hi ${name || 'there'}`);
    await notify(phoneNumber, `echo: ${text}`);
  },
});

const simRoutes = require('../src/routes/sim.routes');
const errorHandler = require('../src/middlewares/errorHandler');

// Load the chat-sim gate against a fresh config snapshot so each test controls
// the ENABLE_CHAT_SIM / NODE_ENV state it runs under.
const loadChatSimGate = (env) => {
  const saved = { ENABLE_CHAT_SIM: process.env.ENABLE_CHAT_SIM, NODE_ENV: process.env.NODE_ENV };
  delete require.cache[require.resolve('../src/middlewares/requireChatSimEnabled')];
  delete require.cache[require.resolve('../src/config/env')];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return require('../src/middlewares/requireChatSimEnabled');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const withServer = async (env, run) => {
  const app = express();
  app.use(express.json());
  app.use('/api/sim', loadChatSimGate(env), simRoutes);
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const postMessage = (base, body) => fetch(`${base}/api/sim/message`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(() => { pipelineCalls.length = 0; });

test('flag enabled: POST /message runs the pipeline and GET /messages/:phone returns the conversation', async () => {
  await withServer({ ENABLE_CHAT_SIM: 'true' }, async (base) => {
    const res = await postMessage(base, { phoneNumber: '+2348000000101', name: 'Ada', text: '  balance  ' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { replies: ['Hi Ada', 'echo: balance'] });

    const history = await fetch(`${base}/api/sim/messages/${encodeURIComponent('+2348000000101')}`);
    assert.equal(history.status, 200);
    const { messages } = await history.json();
    assert.deepEqual(
      messages.map(({ direction, text }) => ({ direction, text })),
      [
        { direction: 'in', text: 'balance' },
        { direction: 'out', text: 'Hi Ada' },
        { direction: 'out', text: 'echo: balance' },
      ],
    );
    for (const message of messages) {
      assert.ok(!Number.isNaN(Date.parse(message.createdAt)), 'createdAt is an ISO timestamp');
    }
  });

  assert.deepEqual(pipelineCalls, [{ phoneNumber: '+2348000000101', name: 'Ada', text: 'balance' }]);
});

test('flag enabled: invalid requests are rejected by route validation without running the pipeline', async () => {
  await withServer({ ENABLE_CHAT_SIM: 'true' }, async (base) => {
    for (const body of [
      { phoneNumber: '+2348000000102' },
      { phoneNumber: '+2348000000102', text: '   ' },
      { phoneNumber: '123', text: 'hi' },
      { phoneNumber: '+2348000000102', text: 'hi', admin: true },
    ]) {
      const res = await postMessage(base, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      const payload = await res.json();
      assert.equal(payload.success, false);
      assert.equal(payload.error.code, 'validation_error');
    }

    const history = await fetch(`${base}/api/sim/messages/123`);
    assert.equal(history.status, 400);
  });

  assert.deepEqual(pipelineCalls, []);
});

test('flag disabled: every sim route returns 404 and never reaches the pipeline', async () => {
  await withServer({ ENABLE_CHAT_SIM: 'false' }, async (base) => {
    const res = await postMessage(base, { phoneNumber: '+2348000000103', text: 'balance' });
    assert.equal(res.status, 404);
    const payload = await res.json();
    assert.equal(payload.success, false);
    assert.equal(payload.message, 'Not found');

    const history = await fetch(`${base}/api/sim/messages/${encodeURIComponent('+2348000000103')}`);
    assert.equal(history.status, 404);
  });

  assert.deepEqual(pipelineCalls, []);
});

test('flag unset in production: sim routes default to disabled', async () => {
  await withServer({ ENABLE_CHAT_SIM: undefined, NODE_ENV: 'production' }, async (base) => {
    const res = await postMessage(base, { phoneNumber: '+2348000000104', text: 'balance' });
    assert.equal(res.status, 404);
  });

  assert.deepEqual(pipelineCalls, []);
});
