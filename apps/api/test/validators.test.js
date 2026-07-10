const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isValidPhoneNumber, isValidAmount } = require('../src/utils/validators');

test('isValidPhoneNumber accepts plausible numbers', () => {
  assert.equal(isValidPhoneNumber('+2348000000000'), true);
  assert.equal(isValidPhoneNumber('1234567'), true);
});

test('isValidPhoneNumber rejects empty, short, or non-string input', () => {
  assert.equal(isValidPhoneNumber(''), false);
  assert.equal(isValidPhoneNumber('12345'), false); // length 5 is not > 5
  assert.equal(isValidPhoneNumber('   '), false);
  assert.equal(isValidPhoneNumber(undefined), false);
  assert.equal(isValidPhoneNumber(2348000000000), false); // not a string
});

test('isValidAmount accepts positive finite numbers and numeric strings', () => {
  assert.equal(isValidAmount('5'), true);
  assert.equal(isValidAmount('2.5'), true);
  assert.equal(isValidAmount(10), true);
});

test('isValidAmount rejects zero, negatives, and non-numeric input', () => {
  assert.equal(isValidAmount('0'), false);
  assert.equal(isValidAmount('-3'), false);
  assert.equal(isValidAmount('abc'), false);
  assert.equal(isValidAmount(''), false);
  assert.equal(isValidAmount(undefined), false);
});
