const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Directly require the target module under test
const { ProviderSkippedError } = require('../src/compliance/providerErrors');

describe('providerErrors.js unit tests', () => {
  test('ProviderSkippedError creates an instance of Error', () => {
    const error = new ProviderSkippedError();
    assert.ok(error instanceof Error);
    assert.ok(error instanceof ProviderSkippedError);
  });

  test('ProviderSkippedError uses default message when no argument is supplied', () => {
    const error = new ProviderSkippedError();
    assert.equal(error.message, 'provider data deletion not configured; skipped');
    assert.equal(error.name, 'ProviderSkippedError');
    assert.equal(error.skipped, true);
  });

  test('ProviderSkippedError preserves custom message when supplied', () => {
    const customMessage = 'Monitoring data deletion not configured';
    const error = new ProviderSkippedError(customMessage);
    assert.equal(error.message, customMessage);
    assert.equal(error.name, 'ProviderSkippedError');
    assert.equal(error.skipped, true);
  });

  test('ProviderSkippedError has stack trace and behaves as standard error throwable', () => {
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

  test('ProviderSkippedError can be distinguished from standard operational errors', () => {
    const skippedErr = new ProviderSkippedError();
    const genericErr = new Error('database down');

    assert.equal(Boolean(skippedErr.skipped), true);
    assert.equal(Boolean(genericErr.skipped), false);
  });
});
