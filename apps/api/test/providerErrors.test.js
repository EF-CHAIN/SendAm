'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { ProviderSkippedError } = require('../src/compliance/providerErrors');

describe('providerErrors', () => {
  it('instantiates ProviderSkippedError with default message and properties', () => {
    const err = new ProviderSkippedError();

    assert.ok(err instanceof Error);
    assert.equal(err.name, 'ProviderSkippedError');
    assert.equal(err.message, 'provider data deletion not configured; skipped');
    assert.equal(err.skipped, true);
  });

  it('instantiates ProviderSkippedError with a custom message', () => {
    const customMsg = 'smile identity deletion skipped due to test environment';
    const err = new ProviderSkippedError(customMsg);

    assert.ok(err instanceof Error);
    assert.equal(err.name, 'ProviderSkippedError');
    assert.equal(err.message, customMsg);
    assert.equal(err.skipped, true);
  });
});
