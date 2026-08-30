const { test } = require('node:test');
const assert = require('node:assert/strict');

const { Samples, percentile } = require('../load/lib/stats');

test('percentile uses nearest rank so every reported value is a real observation', () => {
  const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(sorted, 0.5), 50);
  assert.equal(percentile(sorted, 0.95), 100);
  assert.equal(percentile(sorted, 0.99), 100);
  assert.equal(percentile(sorted, 0), 10);
  assert.equal(percentile(sorted, 1), 100);
});

test('percentile of an empty sample is null, not zero', () => {
  // Zero would read as "instant"; null forces the report to say "n/a".
  assert.equal(percentile([], 0.95), null);
});

test('p99 tracks the tail rather than being dragged down by fast requests', () => {
  const samples = new Samples();
  for (let i = 0; i < 99; i += 1) samples.record({ latencyMs: 10, ok: true, statusCode: 200 });
  samples.record({ latencyMs: 5000, ok: true, statusCode: 200 });

  const summary = samples.summarize(1000);
  assert.equal(summary.latencyMs.p50, 10);
  assert.equal(summary.latencyMs.p99, 10);
  assert.equal(summary.latencyMs.max, 5000);
});

test('summary reports error rate, throughput and failure reasons', () => {
  const samples = new Samples();
  for (let i = 0; i < 8; i += 1) samples.record({ latencyMs: 100, ok: true, statusCode: 200 });
  samples.record({ latencyMs: 100, ok: false, statusCode: 500, reason: 'http_500' });
  samples.record({ latencyMs: 100, ok: false, statusCode: null, reason: 'timeout' });

  const summary = samples.summarize(2000);
  assert.equal(summary.requests, 10);
  assert.equal(summary.ok, 8);
  assert.equal(summary.failed, 2);
  assert.equal(summary.errorRate, 0.2);
  assert.equal(summary.throughputRps, 5);
  assert.deepEqual(summary.errorsByReason, { http_500: 1, timeout: 1 });
  assert.deepEqual(summary.statusCounts, { 200: 8, 500: 1 });
});

test('an empty run reports a zero error rate rather than dividing by zero', () => {
  const summary = new Samples().summarize(1000);
  assert.equal(summary.requests, 0);
  assert.equal(summary.errorRate, 0);
  assert.equal(summary.latencyMs.p95, null);
});
