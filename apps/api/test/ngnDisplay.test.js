const { test } = require('node:test');
const assert = require('node:assert/strict');

const { formatWithNgn } = require('../src/services/ngnDisplay');

test('rate present: appends a rounded naira estimate', () => {
  assert.equal(formatWithNgn(20, 'USDC', 1550), '20 USDC (~₦31,000)');
});

test('rate null: falls back to the plain amount', () => {
  assert.equal(formatWithNgn(20, 'USDC', null), '20 USDC');
});

test('zero amount: still shown, naira estimate is zero', () => {
  assert.equal(formatWithNgn(0, 'USDC', 1550), '0 USDC (~₦0)');
});

test('rounding: 0.5 USDC at rate 1550 rounds to ~₦775', () => {
  assert.equal(formatWithNgn(0.5, 'USDC', 1550), '0.5 USDC (~₦775)');
});

test('rounding: fractional naira values round to the nearest whole number', () => {
  assert.equal(formatWithNgn(1, 'USDC', 1550.7), '1 USDC (~₦1,551)');
  assert.equal(formatWithNgn(3, 'USDC', 333.33), '3 USDC (~₦1,000)');
});

test('XLM always passes through, even with a rate available', () => {
  assert.equal(formatWithNgn(5, 'XLM', 1550), '5 XLM');
  assert.equal(formatWithNgn(5, 'XLM', null), '5 XLM');
});
