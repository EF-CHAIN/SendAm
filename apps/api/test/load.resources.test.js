const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ResourceSampler, parseResidentMemory } = require('../load/lib/resources');

test('parses resident memory out of the Prometheus exposition format', () => {
  const text = [
    '# HELP sendam_process_uptime_seconds Process uptime.',
    'sendam_process_uptime_seconds 12.5',
    '# TYPE sendam_process_resident_memory_bytes gauge',
    'sendam_process_resident_memory_bytes 199016448',
    'sendam_http_requests_total{method="GET"} 4',
  ].join('\n');
  assert.equal(parseResidentMemory(text), 199016448);
});

test('returns null when the memory metric is absent rather than guessing', () => {
  assert.equal(parseResidentMemory('sendam_process_uptime_seconds 1'), null);
});

test('reports why memory was not measured instead of reporting zero', () => {
  const sampler = new ResourceSampler({});
  const { memory } = sampler.report();
  assert.equal(memory.measured, false);
  assert.match(memory.reason, /LOAD_METRICS_TOKEN/);
  // A zero peak would read as "used no memory", which is never true.
  assert.equal(memory.peakBytes, undefined);
});

test('reports why connections were not measured instead of reporting zero', () => {
  const sampler = new ResourceSampler({});
  const { connections } = sampler.report();
  assert.equal(connections.measured, false);
  assert.match(connections.reason, /DATABASE_URL/);
  assert.equal(connections.peakTotal, undefined);
});

test('reports the peak across samples, not the last one', () => {
  // Sampling once at the end would miss the peak: pools drain and memory is
  // reclaimed as soon as the load stops.
  const sampler = new ResourceSampler({ metricsUrl: new URL('http://x/metrics'), metricsToken: 't' });
  sampler.samples.memoryBytes.push(100 * 1024 * 1024, 900 * 1024 * 1024, 200 * 1024 * 1024);

  const { memory } = sampler.report();
  assert.equal(memory.measured, true);
  assert.equal(memory.peakMb, 900);
  assert.equal(memory.samples, 3);
});

test('computes connection utilisation against the server maximum', () => {
  const sampler = new ResourceSampler({ databaseUrl: 'postgres://x' });
  sampler.maxConnections = 100;
  sampler.samples.connections.push({ total: 10, active: 2, idle: 8 }, { total: 45, active: 30, idle: 15 });

  const { connections } = sampler.report();
  assert.equal(connections.peakTotal, 45);
  assert.equal(connections.peakActive, 30);
  assert.equal(connections.utilisation, 0.45);
});

test('utilisation is null when the server maximum is unknown', () => {
  const sampler = new ResourceSampler({ databaseUrl: 'postgres://x' });
  sampler.samples.connections.push({ total: 10, active: 2, idle: 8 });
  assert.equal(sampler.report().connections.utilisation, null);
});
