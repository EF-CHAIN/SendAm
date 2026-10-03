'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { ProviderSkippedError } = require('../src/compliance/providerErrors');

describe('providerErrors', () => {
  it('instantiates ProviderSkippedError with default message and properties', () => {
    const err = new ProviderSkippedError();

    assert.ok(err instanceof Error);
    assert.ok(err instanceof ProviderSkippedError);
    assert.equal(err.name, 'ProviderSkippedError');
    assert.equal(err.message, 'provider data deletion not configured; skipped');
    assert.equal(err.skipped, true);
  });

  it('instantiates ProviderSkippedError with a custom message', () => {
    const customMsg = 'smile identity deletion skipped due to test environment';
    const err = new ProviderSkippedError(customMsg);

    assert.ok(err instanceof Error);
    assert.ok(err instanceof ProviderSkippedError);
    assert.equal(err.name, 'ProviderSkippedError');
    assert.equal(err.message, customMsg);
    assert.equal(err.skipped, true);
  });

  it('has stack trace and behaves as standard throwable error', () => {
    const error = new ProviderSkippedError('custom skip reason');
    assert.ok(error.stack);
    assert.equal(typeof error.stack, 'string');

    assert.throws(
      () => {
        throw error;
      },
      (err) => {
        return (
          err instanceof ProviderSkippedError &&
          err.name === 'ProviderSkippedError' &&
          err.skipped === true &&
          err.message === 'custom skip reason'
        );
      },
    );
  });

  it('can be distinguished from standard operational errors', () => {
    const skippedErr = new ProviderSkippedError();
    const genericErr = new Error('database down');

    assert.equal(Boolean(skippedErr.skipped), true);
    assert.equal(Boolean(genericErr.skipped), false);
  });
});
