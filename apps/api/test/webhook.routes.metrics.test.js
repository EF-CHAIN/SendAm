const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

// Covers the body-parsing / timeout error branches of webhook.routes.js (#436)
// and asserts each increments its dedicated counter. Signature verification,
// schema validation, and the controller are stubbed so the test stays offline
// and can hold a request open until the route timeout fires.
const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

let onControllerReached = () => {};
inject('middlewares/verifyWhatsappSignature', (req, res, next) => next());
inject('common/validation', { validateExternalPayload: () => (req, res, next) => next() });
inject('controllers/webhook.controller', {
  // Never responds, so only the route's requestTimeout can end the request.
  handleIncomingMessage: () => onControllerReached(),
});

const webhookRoutes = require('../src/routes/webhook.routes');
const { renderMetrics, resetMetrics } = require('../src/observability/metrics');

const counterValue = (name) => {
  const line = renderMetrics().split('\n').find((entry) => entry.startsWith(`${name} `));
  return line ? Number(line.slice(name.length + 1)) : 0;
};

const withServer = async (run) => {
  const app = express();
  app.use('/webhook', webhookRoutes);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.type || err.message }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};

beforeEach(() => resetMetrics());
afterEach(() => {
  mock.timers.reset();
  onControllerReached = () => {};
});

test('oversized webhook body returns 413 and increments sendam_webhook_body_too_large_total', async () => {
  const oversized = JSON.stringify({ padding: 'x'.repeat(1024 * 1024 + 1) });

  await withServer(async (base) => {
    const res = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oversized,
    });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'Request body too large' });
  });

  assert.equal(counterValue('sendam_webhook_body_too_large_total'), 1);
  assert.equal(counterValue('sendam_webhook_timeout_total'), 0);
});

test('webhook request exceeding the 30s timeout returns 408 and increments sendam_webhook_timeout_total', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const controllerReached = new Promise((resolve) => { onControllerReached = resolve; });

  await withServer(async (base) => {
    const pending = fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ object: 'whatsapp_business_account', entry: [] }),
    });

    await controllerReached;
    mock.timers.tick(29999);
    assert.equal(counterValue('sendam_webhook_timeout_total'), 0, 'no timeout before 30s');
    mock.timers.tick(1);

    const res = await pending;
    assert.equal(res.status, 408);
    assert.deepEqual(await res.json(), { error: 'Request timed out' });
  });

  assert.equal(counterValue('sendam_webhook_timeout_total'), 1);
  assert.equal(counterValue('sendam_webhook_body_too_large_total'), 0);
});

test('other body-parser failures are passed on without incrementing either counter', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"object":',
    });
    // Malformed JSON is a different body-parser failure and is passed on
    // untouched by this handler, so neither counter moves.
    assert.equal(res.status, 400);
  });

  assert.equal(counterValue('sendam_webhook_body_too_large_total'), 0);
  assert.equal(counterValue('sendam_webhook_timeout_total'), 0);
});
