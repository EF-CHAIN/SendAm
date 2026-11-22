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

const { truncateAmount, toStroops, fromStroops, toStellarAmount, STROOPS_PER_XLM } = require('../src/utils/money');

test('stroop conversion is exact and 1 XLM equals 10,000,000 stroops', () => {
  assert.equal(STROOPS_PER_XLM, 10000000n);
  assert.equal(toStroops('1'), 10000000n);
  assert.equal(toStroops('0.0000001'), 1n);
  assert.equal(toStroops('922337203685.4775807'), 9223372036854775807n);
  assert.equal(fromStroops(1n), '0.0000001');
  assert.equal(fromStroops('15000000'), '1.5000000');
  assert.equal(fromStroops(0n), '0.0000000');
});

test('floating-point sums never leak binary artifacts into Stellar amounts', () => {
  assert.equal(0.1 + 0.2, 0.30000000000000004);
  assert.equal(toStellarAmount(0.1 + 0.2), '0.3000000');
  assert.equal(toStellarAmount('0.1'), '0.1000000');
  assert.equal(fromStroops(toStroops('0.1') + toStroops('0.2')), '0.3000000');
});

test('excess precision is truncated, never rounded up', () => {
  assert.equal(truncateAmount('1.23456789'), '1.2345678');
  assert.equal(truncateAmount('0.99999999'), '0.9999999');
  assert.equal(truncateAmount('2.5', 0), '2');
  assert.equal(truncateAmount('1e-7'), '0.0000001');
  assert.equal(truncateAmount('1.5e-8'), '0.0000000');
  assert.equal(truncateAmount(1 / 3), '0.3333333');
  assert.equal(toStellarAmount('10.00000019'), '10.0000001');
});

test('truncation round-trips for every 7-decimal value tested', () => {
  for (const value of ['0.0000001', '123.4567891', '999999999.9999999', '5']) {
    const canonical = fromStroops(toStroops(value));
    assert.equal(fromStroops(toStroops(canonical)), canonical);
  }
});

test('invalid and out-of-range Stellar amounts are rejected', () => {
  assert.throws(() => toStellarAmount('0'), /greater than zero/);
  assert.throws(() => toStellarAmount('0.00000001'), /greater than zero/);
  assert.throws(() => toStellarAmount('-1'), /positive decimal/);
  assert.throws(() => toStellarAmount('abc'), /positive decimal/);
  assert.throws(() => toStellarAmount(''), /positive decimal/);
  assert.throws(() => toStellarAmount(NaN), /positive decimal/);
  assert.throws(() => toStellarAmount(Infinity), /positive decimal/);
  assert.throws(() => toStroops('922337203685.4775808'), /maximum Stellar amount/);
  assert.throws(() => fromStroops(-1n), /negative/);
  assert.throws(() => fromStroops('1.5'), /integer/);
  assert.throws(() => fromStroops(9223372036854775808n), /maximum Stellar amount/);
});
