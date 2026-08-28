const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createWorkerHealth, startWorkerHealthServer } = require('../src/observability/workerHealth');
const { renderMetrics, resetMetrics } = require('../src/observability/metrics');

beforeEach(() => resetMetrics());

const request = (port, path, token) => new Promise((resolve, reject) => {
  const req = http.get({
    hostname: '127.0.0.1',
    port,
    path,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', reject);
});

test('readiness requires database, Redis, processors, and a fresh heartbeat', async () => {
  let now = 1_000;
  let redisOk = true;
  let databaseOk = true;
  let processors = ['whatsapp-inbound'];
  const health = createWorkerHealth({
    checkDatabase: async () => { if (!databaseOk) throw new Error('database down'); },
    checkRedis: async () => ({ ok: redisOk }),
    getProcessors: () => processors,
    expectedProcessors: ['whatsapp-inbound'],
    heartbeatFreshnessMs: 100,
    workerId: 'worker-a',
    now: () => now,
  });

  assert.equal((await health.check()).status, 'ready');
  redisOk = false;
  assert.equal((await health.check()).checks.redis, false);
  redisOk = true;
  databaseOk = false;
  assert.equal((await health.check()).checks.database, false);
  databaseOk = true;
  processors = [];
  assert.equal((await health.check()).checks.processors, false);
  processors = ['whatsapp-inbound'];
  now += 101;
  const stale = await health.check();
  assert.equal(stale.status, 'not_ready');
  assert.equal(stale.checks.heartbeat, false);
  health.beat();
  assert.equal((await health.check()).status, 'ready');
  health.markShuttingDown();
  assert.equal((await health.check()).status, 'not_ready');
});

test('worker probes and authenticated metrics are served independently from the API', async (t) => {
  process.env.METRICS_TOKEN = 'worker-metrics-token-at-least-32-chars';
  const health = createWorkerHealth({
    checkDatabase: async () => {},
    checkRedis: async () => ({ ok: true }),
    getProcessors: () => ['whatsapp-inbound'],
    expectedProcessors: ['whatsapp-inbound'],
    heartbeatFreshnessMs: 1000,
    workerId: 'worker-probe',
  });
  const runtime = await startWorkerHealthServer({
    health, collectMetrics: async () => {}, port: 0, metricsIntervalMs: 1000,
  });
  t.after(async () => { await runtime.close(); delete process.env.METRICS_TOKEN; });
  const port = runtime.server.address().port;

  assert.equal((await request(port, '/live')).status, 200);
  assert.equal((await request(port, '/ready')).status, 200);
  assert.equal((await request(port, '/metrics')).status, 403);
  const metrics = await request(port, '/metrics', process.env.METRICS_TOKEN);
  assert.equal(metrics.status, 200);
  assert.match(metrics.body, /sendam_worker_ready\{worker_id="worker-probe"\} 1/);
  health.markShuttingDown();
  assert.equal((await request(port, '/ready')).status, 503);
});

test('worker replica metrics carry collision-free worker identifiers', () => {
  const common = {
    checkDatabase: async () => {}, checkRedis: async () => ({ ok: true }),
    getProcessors: () => [], expectedProcessors: [], heartbeatFreshnessMs: 1000,
  };
  createWorkerHealth({ ...common, workerId: 'worker-a' });
  createWorkerHealth({ ...common, workerId: 'worker-b' });
  const metrics = renderMetrics();
  assert.match(metrics, /sendam_worker_info\{worker_id="worker-a"\} 1/);
  assert.match(metrics, /sendam_worker_info\{worker_id="worker-b"\} 1/);
});
