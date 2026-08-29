const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertValidAmount, add, percentage, convert, decimalToRatio, expandExponentialDecimal } = require('../src/utils/money');

test('decimal addition avoids binary floating-point artifacts', () => {
  assert.equal(add('0.10', '0.20', 'USD'), '0.30');
});

test('asset-specific precision is enforced before side effects', () => {
  assert.equal(assertValidAmount('1.1234567', 'XLM'), '1.1234567');
  assert.throws(() => assertValidAmount('1.12345678', 'XLM'), /at most 7 decimal places/);
  assert.throws(() => assertValidAmount('1.001', 'USD'), /at most 2 decimal places/);
});

test('fees use deterministic half-up integer decimal arithmetic', () => {
  assert.equal(percentage('0.0000001', 'XLM', 100), '0.0000000');
  assert.equal(percentage('100.00', 'NGN', 100), '1.00');
});

test('quote conversion rounds to target asset precision', () => {
  assert.equal(convert({ amount: '0.30', sourceAsset: 'USD', targetAsset: 'USDC', rate: '1' }), '0.3000000');
  assert.equal(convert({ amount: '100.00', sourceAsset: 'NGN', targetAsset: 'USDC', rate: '0.000625' }), '0.0625000');
});


test('exchange rates parse exact decimal and exponential values as positive ratios', () => {
  assert.equal(expandExponentialDecimal('6.25e-4'), '0.000625');
  assert.deepEqual(decimalToRatio('0.000625'), { numerator: 625n, denominator: 1000000n, decimal: '0.000625' });
  assert.deepEqual(decimalToRatio('6.25e-4'), { numerator: 625n, denominator: 1000000n, decimal: '0.000625' });
  assert.throws(() => decimalToRatio('-1'), /positive decimal/);
  assert.throws(() => decimalToRatio('0'), /greater than zero/);
});
