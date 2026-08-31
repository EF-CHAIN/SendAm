const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const {
  requestMetrics,
  getMetricSnapshot,
  metricsStore,
  normalizeMethodLabel,
  normalizeRouteLabel,
  normalizeStatusLabel,
} = require('../src/observability/metrics');

const buildApp = () => {
  const app = express();
  const router = express.Router();

  app.use(requestMetrics);
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.post('/webhook', (_req, res) => res.status(200).send('ok'));
  app.get('/metrics', (_req, res) => res.json({ ok: true }));

  router.get('/messages/:phone', (req, res) => res.json({ phone: req.params.phone }));
  app.use('/api/sim', router);
  app.get('/api/admin/stats', (_req, res) => res.json({ ok: true }));
  app.use((_req, res) => res.status(404).json({ ok: false }));
  return app;
};

test('route and status labels are normalized and bounded', () => {
  assert.equal(normalizeMethodLabel('get'), 'GET');
  assert.equal(normalizeMethodLabel('TRACE'), 'OTHER');
  assert.equal(normalizeStatusLabel(200), '200');
  assert.equal(normalizeStatusLabel(418), 'OTHER');

  const matched = { method: 'GET', route: { path: '/messages/:phone' }, baseUrl: '/api/sim', originalUrl: '/api/sim/messages/5551234' };
  assert.equal(normalizeRouteLabel(matched), '/api/sim/messages/:phone');

  const unknown = { method: 'GET', baseUrl: '', originalUrl: '/unknown/12345', route: undefined };
  assert.equal(normalizeRouteLabel(unknown), 'unmatched');
});

test('requestMetrics records stable labels for known and unknown routes', async () => {
  metricsStore.reset();

  const app = buildApp();
  const server = app.listen(0);

  try {
    const port = server.address().port;
    await fetch(`http://127.0.0.1:${port}/health`);
    await fetch(`http://127.0.0.1:${port}/webhook`, { method: 'POST' });
    await fetch(`http://127.0.0.1:${port}/metrics`);
    await fetch(`http://127.0.0.1:${port}/api/sim/messages/5551234`);
    await fetch(`http://127.0.0.1:${port}/api/admin/stats`);
    await fetch(`http://127.0.0.1:${port}/not/a/real/path/123`);

    const sample = getMetricSnapshot();
    const hasHealth = sample.some((entry) => entry.method === 'GET' && entry.route === '/health' && entry.status === '200');
    const hasWebhook = sample.some((entry) => entry.method === 'POST' && entry.route === '/webhook' && entry.status === '200');
    const hasMetrics = sample.some((entry) => entry.method === 'GET' && entry.route === '/metrics' && entry.status === '200');
    const hasParamRoute = sample.some((entry) => entry.method === 'GET' && entry.route === '/api/sim/messages/:phone' && entry.status === '200');
    const hasUnknown = sample.some((entry) => entry.method === 'GET' && entry.route === 'unmatched' && entry.status === '404');

    assert.equal(hasHealth, true);
    assert.equal(hasWebhook, true);
    assert.equal(hasMetrics, true);
    assert.equal(hasParamRoute, true);
    assert.equal(hasUnknown, true);
    assert.equal(sample.some((entry) => entry.route && entry.route.includes('123')), false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
