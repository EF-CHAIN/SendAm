const { test } = require('node:test');
const assert = require('node:assert/strict');
const { captureException } = require('../src/observability/errors');
const { runWithContext } = require('../src/observability/context');

test('exception reporter sends a correlated, redacted alert payload', async () => {
  const originalFetch = global.fetch;
  let request;
  process.env.ERROR_MONITOR_WEBHOOK_URL = 'https://alerts.example.test/events';
  process.env.ERROR_MONITOR_TOKEN = 'alert-routing-token';
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true };
  };
  try {
    const delivered = await runWithContext(
      { correlationId: 'corr-error-1' },
      () => captureException(new Error('payment failed pin=1234'), {
        source: 'worker',
        apiToken: 'must-not-leak',
      }),
    );
    assert.equal(delivered, true);
    const payload = JSON.parse(request.options.body);
    assert.equal(payload.context.correlationId, 'corr-error-1');
    assert.equal(payload.context.apiToken, '[REDACTED]');
    assert.doesNotMatch(request.options.body, /1234|must-not-leak/);
    assert.equal(request.options.headers.authorization, 'Bearer alert-routing-token');
  } finally {
    global.fetch = originalFetch;
    delete process.env.ERROR_MONITOR_WEBHOOK_URL;
    delete process.env.ERROR_MONITOR_TOKEN;
  }
});

test('exception reporter degrades safely when monitoring is unconfigured', async () => {
  delete process.env.ERROR_MONITOR_WEBHOOK_URL;
  assert.equal(await captureException(new Error('test'), { source: 'test' }), false);
});
