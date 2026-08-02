const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  correlationMiddleware,
  correlationIdFrom,
  getContext,
} = require('../src/observability/context');

test('accepts a safe incoming correlation ID and exposes it in async context', async () => {
  const req = {
    method: 'GET',
    path: '/health',
    get: (name) => (name === 'x-correlation-id' ? 'request-123' : undefined),
  };
  const headers = {};
  const res = { set: (name, value) => { headers[name] = value; } };
  let observed;
  await new Promise((resolve) => {
    correlationMiddleware(req, res, () => {
      setImmediate(() => {
        observed = getContext();
        resolve();
      });
    });
  });
  assert.equal(headers['x-correlation-id'], 'request-123');
  assert.equal(observed.correlationId, 'request-123');
});

test('replaces malicious or oversized correlation IDs', () => {
  const generated = correlationIdFrom('bad id\\nforged-log');
  assert.match(generated, /^[0-9a-f-]{36}$/);
  assert.notEqual(generated, 'bad id\\nforged-log');
});
