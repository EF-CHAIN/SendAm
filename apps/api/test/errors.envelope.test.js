const { test } = require('node:test');
const assert = require('node:assert/strict');
const { errorEnvelope } = require('../src/errors/envelope');
const { AppError } = require('../src/errors');
const { runWithContext } = require('../src/observability/context');

test('envelope carries version, stable code, message, and correlation id', () => {
  const body = runWithContext(
    { correlationId: 'corr-abc' },
    () => errorEnvelope(new AppError('validation_error', 'A valid phoneNumber is required')),
  );
  assert.equal(body.success, false);
  assert.equal(body.message, 'A valid phoneNumber is required');
  assert.equal(body.error.version, '1.0');
  assert.equal(body.error.code, 'validation_error');
  assert.equal(body.error.message, 'A valid phoneNumber is required');
  assert.equal(body.error.correlationId, 'corr-abc');
});

test('explicit correlation id wins over the async context value', () => {
  const body = runWithContext(
    { correlationId: 'context-id' },
    () => errorEnvelope(new AppError('conflict', 'nope'), { correlationId: 'explicit-id' }),
  );
  assert.equal(body.error.correlationId, 'explicit-id');
});

test('internal failures never leak the raw message', () => {
  const body = runWithContext(
    { correlationId: 'corr-secret' },
    () => errorEnvelope(new Error('disk full token=supersecret')),
  );
  assert.equal(body.error.code, 'internal_error');
  assert.equal(body.error.message, 'An unexpected error occurred.');
  assert.doesNotMatch(JSON.stringify(body), /supersecret|disk/);
});

test('nested details are sanitized so secrets cannot reach the response', () => {
  const body = runWithContext(
    { correlationId: 'corr-1' },
    () => errorEnvelope(new AppError('validation_error', 'bad input', { details: { token: 'must-not-leak' } })),
  );
  assert.equal(body.error.details.token, '[REDACTED]');
  assert.doesNotMatch(JSON.stringify(body), /must-not-leak/);
});

test('details are omitted when absent', () => {
  const body = runWithContext(
    { correlationId: 'corr-2' },
    () => errorEnvelope(new AppError('forbidden', 'Forbidden')),
  );
  assert.equal('details' in body.error, false);
});
