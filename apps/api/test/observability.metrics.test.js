const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  increment,
  observeDuration,
  renderMetrics,
  metricsHandler,
  resetMetrics,
} = require('../src/observability/metrics');

beforeEach(() => resetMetrics());

test('renders Prometheus counters and histograms with bounded labels', () => {
  increment('sendam_http_requests_total', { method: 'GET', route: '/health', status_code: 200 });
  observeDuration('sendam_http_request_duration_seconds', { method: 'GET', route: '/health', status_code: 200 }, 0.2);
  const body = renderMetrics();
  assert.match(body, /sendam_http_requests_total\{method="GET",route="\/health",status_code="200"\} 1/);
  assert.match(body, /sendam_http_request_duration_seconds_count.* 1/);
  assert.match(body, /sendam_process_resident_memory_bytes/);
});

test('metrics endpoint requires the dedicated bearer token', () => {
  process.env.METRICS_TOKEN = 'metrics-token-at-least-32-characters';
  const makeResponse = () => ({
    statusCode: null,
    body: null,
    sendStatus(code) { this.statusCode = code; return this; },
    type() { return this; },
    send(body) { this.statusCode = 200; this.body = body; return this; },
  });
  const denied = makeResponse();
  metricsHandler({ get: () => 'Bearer wrong' }, denied);
  assert.equal(denied.statusCode, 403);

  const allowed = makeResponse();
  metricsHandler({ get: () => `Bearer ${process.env.METRICS_TOKEN}` }, allowed);
  assert.equal(allowed.statusCode, 200);
  assert.match(allowed.body, /sendam_process_uptime_seconds/);
  delete process.env.METRICS_TOKEN;
});
