const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { AppError } = require('../src/errors/AppError');
const { CATALOG } = require('../src/errors/catalog');

describe('AppError constructor and inheritance', () => {
  test('inherits from Error and sets name property to AppError', () => {
    const err = new AppError('validation_error', 'Invalid parameter');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof AppError);
    assert.equal(err.name, 'AppError');
    assert.equal(err.message, 'Invalid parameter');
    assert.equal(err.code, 'validation_error');
    assert.equal(err.statusCode, 400);
    assert.equal(err.safe, true);
    assert.ok(typeof err.stack === 'string');
  });

  test('resolves default message, status code, and safe flag from catalog', () => {
    const err = new AppError('not_found');
    assert.equal(err.message, CATALOG.NOT_FOUND.defaultMessage);
    assert.equal(err.statusCode, CATALOG.NOT_FOUND.statusCode);
    assert.equal(err.safe, CATALOG.NOT_FOUND.safe);
    assert.equal(err.code, 'not_found');
  });

  test('falls back to INTERNAL catalog defaults for unknown or non-string codes', () => {
    const err = new AppError('custom_unknown_code');
    assert.equal(err.code, 'custom_unknown_code');
    assert.equal(err.message, CATALOG.INTERNAL.defaultMessage);
    assert.equal(err.statusCode, CATALOG.INTERNAL.statusCode);
    assert.equal(err.safe, CATALOG.INTERNAL.safe);

    const nonStringCodeErr = new AppError(null);
    assert.equal(nonStringCodeErr.code, null);
    assert.equal(nonStringCodeErr.message, CATALOG.INTERNAL.defaultMessage);
  });

  test('allows overriding statusCode, safe flag, and details via options', () => {
    const details = { field: 'phone', reason: 'malformed' };
    const err = new AppError('validation_error', 'Custom validation message', {
      statusCode: 422,
      safe: false,
      details,
    });
    assert.equal(err.message, 'Custom validation message');
    assert.equal(err.statusCode, 422);
    assert.equal(err.safe, false);
    assert.deepEqual(err.details, details);
  });

  test('wraps original cause when provided in options', () => {
    const originalError = new Error('Database connection timed out');
    const err = new AppError('internal_error', 'Operation failed', {
      cause: originalError,
    });
    assert.equal(err.cause, originalError);
  });
});

describe('AppError static factories', () => {
  test('AppError.validation creates validation_error with status 400 and optional details', () => {
    const details = [{ field: 'amount', message: 'must be positive' }];
    const cause = new Error('Parse error');
    const err = AppError.validation('Amount is invalid', details, { cause });

    assert.ok(err instanceof AppError);
    assert.equal(err.code, 'validation_error');
    assert.equal(err.statusCode, 400);
    assert.equal(err.safe, true);
    assert.equal(err.message, 'Amount is invalid');
    assert.deepEqual(err.details, details);
    assert.equal(err.cause, cause);
  });

  test('AppError.unauthorized creates unauthorized with status 401', () => {
    const cause = new Error('Token expired');
    const err = AppError.unauthorized('Invalid access token', { cause });

    assert.equal(err.code, 'unauthorized');
    assert.equal(err.statusCode, 401);
    assert.equal(err.safe, true);
    assert.equal(err.message, 'Invalid access token');
    assert.equal(err.cause, cause);
  });

  test('AppError.forbidden creates forbidden with status 403', () => {
    const err = AppError.forbidden('Access denied');

    assert.equal(err.code, 'forbidden');
    assert.equal(err.statusCode, 403);
    assert.equal(err.safe, true);
    assert.equal(err.message, 'Access denied');
  });

  test('AppError.notFound creates not_found with status 404', () => {
    const err = AppError.notFound('Account not found');

    assert.equal(err.code, 'not_found');
    assert.equal(err.statusCode, 404);
    assert.equal(err.safe, true);
    assert.equal(err.message, 'Account not found');
  });

  test('AppError.conflict creates conflict with status 409 and details', () => {
    const details = { resource: 'wallet', id: '123' };
    const err = AppError.conflict('State conflict occurred', details);

    assert.equal(err.code, 'conflict');
    assert.equal(err.statusCode, 409);
    assert.equal(err.safe, true);
    assert.equal(err.message, 'State conflict occurred');
    assert.deepEqual(err.details, details);
  });

  test('AppError.rateLimited creates rate_limited with status 429', () => {
    const err = AppError.rateLimited('Rate limit exceeded');

    assert.equal(err.code, 'rate_limited');
    assert.equal(err.statusCode, 429);
    assert.equal(err.safe, true);
    assert.equal(err.message, 'Rate limit exceeded');
  });

  test('AppError.provider creates provider_error with status 502 and details', () => {
    const details = { provider: 'stellar_horizon', status: 504 };
    const err = AppError.provider('Upstream Horizon request timed out', details);

    assert.equal(err.code, 'provider_error');
    assert.equal(err.statusCode, 502);
    assert.equal(err.safe, true);
    assert.equal(err.message, 'Upstream Horizon request timed out');
    assert.deepEqual(err.details, details);
  });

  test('AppError.unavailable creates service_unavailable with status 503', () => {
    const err = AppError.unavailable('Service undergoing maintenance');

    assert.equal(err.code, 'service_unavailable');
    assert.equal(err.statusCode, 503);
    assert.equal(err.safe, true);
    assert.equal(err.message, 'Service undergoing maintenance');
  });

  test('AppError.internal creates internal_error with safe=false and status 500', () => {
    const underlying = new Error('Disk write failure');
    const err = AppError.internal('Internal database error', { cause: underlying });

    assert.equal(err.code, 'internal_error');
    assert.equal(err.statusCode, 500);
    assert.equal(err.safe, false);
    assert.equal(err.message, 'Internal database error');
    assert.equal(err.cause, underlying);
  });
});
