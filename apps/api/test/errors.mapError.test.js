const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeError } = require('../src/errors/mapError');
const { AppError } = require('../src/errors');

test('AppError keeps its code, status, and client-safe message', () => {
  const result = normalizeError(new AppError('conflict', 'Quote is expired'));
  assert.deepEqual(
    { code: result.code, statusCode: result.statusCode, message: result.message, safe: result.safe },
    { code: 'conflict', statusCode: 409, message: 'Quote is expired', safe: true },
  );
});

test('internal AppError message is hidden behind the generic catalog message', () => {
  const result = normalizeError(new AppError('internal_error', 'pg password leaked=secret'));
  assert.equal(result.code, 'internal_error');
  assert.equal(result.statusCode, 500);
  assert.equal(result.safe, false);
  assert.equal(result.message, 'An unexpected error occurred.');
  assert.doesNotMatch(result.message, /secret/);
});

test('plain errors map to internal_error with a secret-safe message', () => {
  const result = normalizeError(new Error('boom at /etc/passwd key=abc123'));
  assert.equal(result.code, 'internal_error');
  assert.equal(result.statusCode, 500);
  assert.equal(result.message, 'An unexpected error occurred.');
});

test('errors carrying a statusCode map by that status', () => {
  const unauthorized = new Error('bad token');
  unauthorized.statusCode = 401;
  assert.equal(normalizeError(unauthorized).code, 'unauthorized');

  const notFound = new Error('no such thing');
  notFound.statusCode = 404;
  assert.equal(normalizeError(notFound).code, 'not_found');

  const forbidden = new Error('nope');
  forbidden.statusCode = 403;
  assert.equal(normalizeError(forbidden).code, 'forbidden');
});

test('Prisma conflict (P2002) maps to conflict / 409', () => {
  const error = Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['messageId'] } });
  const result = normalizeError(error);
  assert.equal(result.code, 'conflict');
  assert.equal(result.statusCode, 409);
});

test('Prisma not-found (P2025) maps to not_found / 404', () => {
  const error = Object.assign(new Error('Record not found'), { code: 'P2025' });
  const result = normalizeError(error);
  assert.equal(result.code, 'not_found');
  assert.equal(result.statusCode, 404);
});

test('Prisma validation (P2012) maps to validation_error / 400', () => {
  const error = Object.assign(new Error('Missing required value'), { code: 'P2012' });
  const result = normalizeError(error);
  assert.equal(result.code, 'validation_error');
  assert.equal(result.statusCode, 400);
});

test('rate-limit errors map to rate_limited / 429', () => {
  const expressRateLimit = Object.assign(new Error('Too many requests'), { name: 'RateLimitError', code: 'ERR_ERL_LIMIT', statusCode: 429 });
  const result = normalizeError(expressRateLimit);
  assert.equal(result.code, 'rate_limited');
  assert.equal(result.statusCode, 429);

  const bare429 = new Error('slow down');
  bare429.statusCode = 429;
  assert.equal(normalizeError(bare429).code, 'rate_limited');
});

test('body-parser failures map to validation_error / 400', () => {
  const error = Object.assign(new Error('Unexpected token } in JSON'), { type: 'entity.parse.failed', status: 400 });
  const result = normalizeError(error);
  assert.equal(result.code, 'validation_error');
  assert.equal(result.statusCode, 400);
});

test('axios/provider request errors map to provider_error / 502', () => {
  const error = Object.assign(new Error('connect ECONNREFUSED'), {
    isAxiosError: true,
    config: { url: 'https://api.provider.test' },
    response: { status: 503, data: {} },
  });
  const result = normalizeError(error);
  assert.equal(result.code, 'provider_error');
  assert.equal(result.statusCode, 502);
});

test('non-Error throwables degrade safely', () => {
  const result = normalizeError('string failure');
  assert.equal(result.code, 'internal_error');
  assert.equal(result.statusCode, 500);
  assert.equal(result.message, 'An unexpected error occurred.');
});
