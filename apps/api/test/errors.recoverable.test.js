const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeError } = require('../src/errors/mapError');

test('recoverable missing_trustline maps to conflict', () => {
  const result = normalizeError(Object.assign(new Error('Missing trustline'), { code: 'missing_trustline', action: 'open_trustline', retryable: false }));
  assert.strictEqual(result.code, 'conflict');
  assert.strictEqual(result.statusCode, 409);
  assert.ok(result.message.includes('trustline') || result.message.includes('conflict'));
});

test('recoverable unsupported_asset maps to validation', () => {
  const result = normalizeError(Object.assign(new Error('Unsupported asset'), { code: 'unsupported_asset', retryable: false }));
  assert.strictEqual(result.code, 'validation_error');
  assert.strictEqual(result.statusCode, 400);
});

test('recoverable account_not_funded maps to not_found', () => {
  const result = normalizeError(Object.assign(new Error('Account not funded'), { code: 'account_not_funded', retryable: true }));
  assert.strictEqual(result.code, 'not_found');
  assert.strictEqual(result.statusCode, 404);
  assert.strictEqual(result.details?.retryable, true);
});

test('recoverable source_not_authorized maps to forbidden', () => {
  const result = normalizeError(Object.assign(new Error('Not authorized'), { code: 'source_not_authorized', retryable: false, action: 'contact_support' }));
  assert.strictEqual(result.code, 'forbidden');
  assert.strictEqual(result.statusCode, 403);
  assert.strictEqual(result.details?.action, 'contact_support');
});

test('recoverable bad_sequence maps to unavailable', () => {
  const result = normalizeError(Object.assign(new Error('Sequence conflict'), { code: 'bad_sequence', retryable: true }));
  assert.strictEqual(result.code, 'service_unavailable');
  assert.strictEqual(result.statusCode, 503);
  assert.strictEqual(result.details?.retryable, true);
});
