const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalizePhoneNumber,
  isValidPhoneNumber,
  isValidAmount,
} = require('../src/utils/validators');

describe('canonicalizePhoneNumber', () => {
  test('canonicalizes standard E.164 Nigerian phone number', () => {
    const result = canonicalizePhoneNumber('+2348000000001');
    assert.equal(result, '+2348000000001');
  });

  test('canonicalizes local Nigerian number without country code', () => {
    const result = canonicalizePhoneNumber('08000000001');
    assert.equal(result, '+2348000000001');
  });

  test('canonicalizes number missing leading +', () => {
    const result = canonicalizePhoneNumber('2348000000001');
    assert.equal(result, '+2348000000001');
  });

  test('canonicalizes numbers with spaces and dashes', () => {
    const result = canonicalizePhoneNumber('+234 800-000-0001');
    assert.equal(result, '+2348000000001');
  });

  test('canonicalizes valid international US phone number', () => {
    const result = canonicalizePhoneNumber('+12025550123');
    assert.equal(result, '+12025550123');
  });

  test('throws error for invalid string or non-phone inputs', () => {
    assert.throws(() => canonicalizePhoneNumber('123'), /Invalid or unsupported phone number/);
    assert.throws(() => canonicalizePhoneNumber('not-a-phone'), /Invalid or unsupported phone number/);
    assert.throws(() => canonicalizePhoneNumber(''), /Invalid phone number/);
    assert.throws(() => canonicalizePhoneNumber(null), /Invalid phone number/);
  });
});

describe('isValidPhoneNumber', () => {
  test('returns true for valid phone numbers in various formats', () => {
    assert.equal(isValidPhoneNumber('+2348000000001'), true);
    assert.equal(isValidPhoneNumber('08000000001'), true);
    assert.equal(isValidPhoneNumber('2348000000001'), true);
    assert.equal(isValidPhoneNumber('+234 800 000 0001'), true);
    assert.equal(isValidPhoneNumber('+12025550123'), true);
  });

  test('returns false for invalid, ambiguous, or empty inputs', () => {
    assert.equal(isValidPhoneNumber('123'), false);
    assert.equal(isValidPhoneNumber('abc'), false);
    assert.equal(isValidPhoneNumber(''), false);
    assert.equal(isValidPhoneNumber(null), false);
    assert.equal(isValidPhoneNumber(undefined), false);
  });
});

describe('isValidAmount', () => {
  test('returns true for positive numeric values', () => {
    assert.equal(isValidAmount(100), true);
    assert.equal(isValidAmount('50.25'), true);
  });

  test('returns false for non-positive or non-numeric values', () => {
    assert.equal(isValidAmount(0), false);
    assert.equal(isValidAmount(-10), false);
    assert.equal(isValidAmount('abc'), false);
    assert.equal(isValidAmount(null), false);
  });
});