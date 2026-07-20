const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const createSimController = require('../src/controllers/sim.controller');

// Fake pipeline standing in for assistant.service's real processMessage —
// keeps this test offline (no Prisma/DATABASE_URL) while still exercising
// the controller's request handling, reply capture, and storage.
const fakePipeline = async (phoneNumber, name, text, { notify }) => {
  const normalized = String(text || '').trim().toLowerCase();
  if (normalized === 'balance') {
    await notify(phoneNumber, 'Your SendAm balances:\nstellar: 10');
    return;
  }
  await notify(phoneNumber, `echo: ${text}`);
};

const buildApp = (processMessage = fakePipeline) => {
  const controller = createSimController({ processMessage });
  const app = express();
  app.use(express.json());
  app.post('/api/sim/message', controller.handleMessage);
  app.get('/api/sim/messages/:phone', controller.listMessages);
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
};

const withServer = async (app, run) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

test('POST /api/sim/message runs the pipeline and returns replies in order', async () => {
  await withServer(buildApp(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/sim/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phoneNumber: '+2348000000001', text: 'balance' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.replies, ['Your SendAm balances:\nstellar: 10']);
  });
});

test('POST /api/sim/message rejects invalid phone numbers and stores nothing', async () => {
  await withServer(buildApp(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/sim/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phoneNumber: '123', text: 'hi' }),
    });
    assert.equal(res.status, 400);

    const listRes = await fetch(`${baseUrl}/api/sim/messages/123`);
    const listBody = await listRes.json();
    // The phone itself is invalid, so listing it 400s too — nothing to see.
    assert.equal(listRes.status, 400);
    assert.equal(listBody.messages, undefined);
  });
});

test('POST /api/sim/message rejects missing text', async () => {
  await withServer(buildApp(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/sim/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phoneNumber: '+2348000000001' }),
    });
    assert.equal(res.status, 400);
  });
});

test('GET /api/sim/messages/:phone returns the full ordered conversation', async () => {
  const app = buildApp();
  await withServer(app, async (baseUrl) => {
    const phoneNumber = '+2348000000002';
    await fetch(`${baseUrl}/api/sim/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phoneNumber, text: 'hello' }),
    });
    await fetch(`${baseUrl}/api/sim/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phoneNumber, text: 'balance' }),
    });

    const res = await fetch(`${baseUrl}/api/sim/messages/${encodeURIComponent(phoneNumber)}`);
    assert.equal(res.status, 200);
    const { messages } = await res.json();

    assert.deepEqual(
      messages.map((m) => [m.direction, m.text]),
      [
        ['in', 'hello'],
        ['out', 'echo: hello'],
        ['in', 'balance'],
        ['out', 'Your SendAm balances:\nstellar: 10'],
      ]
    );
  });
});

test('GET /api/sim/messages/:phone?since= narrows to strictly-newer messages', async () => {
  const app = buildApp();
  await withServer(app, async (baseUrl) => {
    const phoneNumber = '+2348000000003';
    await fetch(`${baseUrl}/api/sim/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phoneNumber, text: 'hello' }),
    });

    const midpoint = new Date().toISOString();

    await fetch(`${baseUrl}/api/sim/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phoneNumber, text: 'balance' }),
    });

    const res = await fetch(`${baseUrl}/api/sim/messages/${encodeURIComponent(phoneNumber)}?since=${encodeURIComponent(midpoint)}`);
    const { messages } = await res.json();

    assert.deepEqual(
      messages.map((m) => m.text),
      ['balance', 'Your SendAm balances:\nstellar: 10']
    );
  });
});

test('GET /api/sim/messages/:phone rejects a malformed since value', async () => {
  await withServer(buildApp(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/sim/messages/+2348000000004?since=not-a-date`);
    assert.equal(res.status, 400);
  });
});
