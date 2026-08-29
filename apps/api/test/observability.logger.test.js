const { test } = require('node:test');
const assert = require('node:assert/strict');
const logger = require('../src/utils/logger');
const { runWithContext } = require('../src/observability/context');

test('production logs are structured, correlated JSON and redact secrets and PINs', () => {
  const original = console.log;
  const lines = [];
  console.log = (line) => lines.push(line);
  try {
    runWithContext({ correlationId: 'corr-123', jobId: 'job-7' }, () => {
      logger.info('payment_requested pin=1234', {
        phoneNumber: '+2348000000000',
        pin: '1234',
        password: 'hunter2',
        authorization: 'Bearer live-token',
        nested: { apiKey: 'provider-key', amount: '10' },
      });
    });
  } finally {
    console.log = original;
  }

  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.level, 'info');
  assert.equal(record.correlationId, 'corr-123');
  assert.equal(record.jobId, 'job-7');
  assert.equal(record.data.pin, '[REDACTED]');
  assert.equal(record.data.password, '[REDACTED]');
  assert.equal(record.data.authorization, '[REDACTED]');
  assert.equal(record.data.nested.apiKey, '[REDACTED]');
  assert.equal(record.data.nested.amount, '10');
  assert.doesNotMatch(lines[0], /1234|hunter2|live-token|provider-key/);
});

test('logger safely serializes errors, buffers, and circular structures', () => {
  const value = { buffer: Buffer.from('secret bytes') };
  value.self = value;
  const sanitized = logger.sanitize({ value, error: new Error('token=top-secret') });
  assert.equal(sanitized.value.buffer, '[Buffer 12 bytes]');
  assert.equal(sanitized.value.self, '[Circular]');
  assert.doesNotMatch(sanitized.error.message, /top-secret/);
});
