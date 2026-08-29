const { test } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateQueueHealth } = require('../src/observability/queueAlerting.service');
const { renderMetrics, resetMetrics } = require('../src/observability/metrics');

test('evaluateQueueHealth returns healthy when under thresholds', () => {
  resetMetrics();

  const health = evaluateQueueHealth('whatsapp-messages', {
    waiting: 5,
    active: 2,
    failed: 0,
    delayed: 1,
    oldestJobAgeSeconds: 10,
  });

  assert.equal(health.isHealthy, true);
  assert.equal(health.backlog, 7);
  assert.equal(health.alerts.length, 0);

  const metricsText = renderMetrics();
  assert.ok(metricsText.includes('sendam_queue_backlog_size{queue="whatsapp-messages"} 7'));
  assert.ok(metricsText.includes('sendam_queue_waiting_jobs{queue="whatsapp-messages"} 5'));
  assert.ok(metricsText.includes('sendam_queue_lag_seconds{queue="whatsapp-messages"} 10'));
});

test('evaluateQueueHealth triggers warning when backlog exceeds 50', () => {
  resetMetrics();

  const health = evaluateQueueHealth('payments', {
    waiting: 55,
    active: 5,
    failed: 0,
    oldestJobAgeSeconds: 20,
  });

  assert.equal(health.isHealthy, false);
  assert.equal(health.backlog, 60);
  assert.ok(health.alerts.some((a) => a.includes('WARNING: Queue "payments" backlog (60)')));
});

test('evaluateQueueHealth triggers critical when backlog exceeds 200', () => {
  resetMetrics();

  const health = evaluateQueueHealth('payments', {
    waiting: 205,
    active: 10,
    failed: 0,
    oldestJobAgeSeconds: 30,
  });

  assert.equal(health.isHealthy, false);
  assert.equal(health.backlog, 215);
  assert.ok(health.alerts.some((a) => a.includes('CRITICAL: Queue "payments" backlog (215)')));
});

test('evaluateQueueHealth triggers alert when job lag exceeds thresholds', () => {
  resetMetrics();

  const health = evaluateQueueHealth('notifications', {
    waiting: 10,
    active: 2,
    oldestJobAgeSeconds: 650, // > 600s critical
  });

  assert.equal(health.isHealthy, false);
  assert.ok(health.alerts.some((a) => a.includes('CRITICAL: Queue "notifications" oldest job age (650s)')));
});
