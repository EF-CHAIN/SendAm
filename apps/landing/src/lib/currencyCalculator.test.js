import { describe, it, expect } from 'vitest';
import {
  CRYPTO_DECIMALS,
  MAX_TRANSFER_AMOUNT,
  calculateQuote,
  formatUnits,
  getRate,
  parseAmount,
  toUnits,
} from './currencyCalculator.js';
import { EXCHANGE_RATES } from './currencyConstants.js';

const quote = (amount, sourceCurrency = 'USD', targetCurrency = 'NGN', extra = {}) =>
  calculateQuote({ amount, sourceCurrency, targetCurrency, ...extra });

describe('parseAmount', () => {
  it.each([
    ['100', 1_000_000_000n],
    ['0', 0n],
    ['0.5', 5_000_000n],
    ['.5', 5_000_000n],
    ['12.', 120_000_000n],
    ['  7.25 ', 72_500_000n],
    ['0.0000001', 1n],
    ['123.4567891', 1_234_567_891n],
    [42, 420_000_000n],
  ])('parses %j exactly', (input, units) => {
    expect(parseAmount(input)).toEqual({ units, error: null });
  });

  it.each([
    [undefined, 'empty'],
    [null, 'empty'],
    ['', 'empty'],
    ['   ', 'empty'],
    ['.', 'empty'],
    ['-1', 'negative'],
    ['-0.0000001', 'negative'],
    ['abc', 'invalid'],
    ['1e5', 'invalid'],
    ['1,000', 'invalid'],
    ['1.2.3', 'invalid'],
    ['Infinity', 'invalid'],
    ['NaN', 'invalid'],
    ['0.00000001', 'too_precise'],
  ])('rejects %j as %s with zero units', (input, error) => {
    expect(parseAmount(input)).toEqual({ units: 0n, error });
  });
});

describe('toUnits / formatUnits', () => {
  it('round-trips at 7-decimal precision without float error', () => {
    expect(formatUnits(toUnits('0.1'))).toBe('0.1000000');
    expect(formatUnits(toUnits(0.1) + toUnits(0.2))).toBe('0.3000000');
    expect(formatUnits(toUnits(1e-7))).toBe('0.0000001');
    expect(formatUnits(toUnits('922337203685.4775807'))).toBe('922337203685.4775807');
    expect(formatUnits(-15n)).toBe('-0.0000015');
    expect(formatUnits(0n)).toBe('0.0000000');
  });

  it('throws on values it cannot represent', () => {
    expect(() => toUnits('-1')).toThrow(RangeError);
    expect(() => toUnits(Number.NaN)).toThrow(RangeError);
    expect(() => toUnits(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => toUnits(0.12345678)).toThrow(/too_precise/);
  });

  it('uses 7 decimals, matching Stellar stroops', () => {
    expect(CRYPTO_DECIMALS).toBe(7);
  });
});

describe('getRate', () => {
  it('returns configured corridor rates as decimal strings', () => {
    expect(getRate('USD', 'NGN')).toBe('1550');
    expect(getRate('USD', 'GHS')).toBe('15.5');
  });

  it('returns null for unknown corridors', () => {
    expect(getRate('XYZ', 'NGN')).toBeNull();
    expect(getRate('USD', 'XYZ')).toBeNull();
  });

  it.each([
    [{ USD: { NGN: 0 } }],
    [{ USD: { NGN: -3 } }],
    [{ USD: { NGN: Number.NaN } }],
    [{ USD: { NGN: Number.POSITIVE_INFINITY } }],
    [{ USD: { NGN: '1550' } }],
    [{}],
    [null],
  ])('returns null for malformed rate table %j', (rates) => {
    expect(getRate('USD', 'NGN', rates)).toBeNull();
  });
});

describe('calculateQuote', () => {
  it('quotes the default corridor exactly', () => {
    expect(quote('100')).toEqual({
      amount: '100.0000000',
      rate: '1550',
      fee: '1.0000000',
      traditionalFee: '7.0000000',
      netAmount: '99.0000000',
      receivedAmount: '153450.0000000',
      savings: '6.0000000',
      savingsInTarget: '9300.0000000',
      exceedsLimit: false,
      maxAmount: '1000.0000000',
      error: null,
    });
  });

  it('matches every configured corridor with no rounding error', () => {
    for (const [source, targets] of Object.entries(EXCHANGE_RATES)) {
      for (const [target, rate] of Object.entries(targets)) {
        const result = quote('250', source, target);
        // 250 - 1% = 247.5; multiply in integer tenths to stay exact.
        const expected = (2475 * rate * 10) / 100;
        expect(result.receivedAmount).toBe(expected.toFixed(7));
        expect(result.error).toBeNull();
      }
    }
  });

  it('returns an all-zero quote for zero and empty input', () => {
    for (const amount of ['0', '', undefined]) {
      const result = quote(amount);
      expect(result.amount).toBe('0.0000000');
      expect(result.fee).toBe('0.0000000');
      expect(result.receivedAmount).toBe('0.0000000');
      expect(result.savings).toBe('0.0000000');
      expect(result.exceedsLimit).toBe(false);
    }
    expect(quote('0').error).toBeNull();
    expect(quote('').error).toBe('empty');
  });

  it('never quotes a negative amount', () => {
    const result = quote('-50');
    expect(result.error).toBe('negative');
    expect(result.amount).toBe('0.0000000');
    expect(result.receivedAmount).toBe('0.0000000');
    expect(result.savings).toBe('0.0000000');
  });

  it('keeps 7-decimal precision for the smallest amounts', () => {
    const result = quote('0.0000001', 'USD', 'GHS');
    // 1% of one stroop rounds half-up to zero; nothing is lost or invented.
    expect(result.fee).toBe('0.0000000');
    expect(result.netAmount).toBe('0.0000001');
    expect(result.receivedAmount).toBe('0.0000016'); // 0.00000155 rounded half-up
    expect(quote('0.0000050').fee).toBe('0.0000001'); // 0.00000005 rounds up
    expect(quote('0.0000049').fee).toBe('0.0000000');
  });

  it('avoids binary floating-point drift', () => {
    const result = quote('0.1', 'USD', 'GHS');
    expect(result.fee).toBe('0.0010000');
    expect(result.netAmount).toBe('0.0990000');
    expect(result.receivedAmount).toBe('1.5345000');
    // 0.1 + 0.2 style inputs stay exact.
    expect(quote('0.3').netAmount).toBe('0.2970000');
  });

  it('accepts the maximum transfer amount exactly', () => {
    const result = quote(MAX_TRANSFER_AMOUNT);
    expect(result.exceedsLimit).toBe(false);
    expect(result.amount).toBe('1000.0000000');
    expect(result.receivedAmount).toBe('1534500.0000000');
  });

  it('clamps and flags amounts one stroop above the maximum', () => {
    const result = quote('1000.0000001');
    expect(result.exceedsLimit).toBe(true);
    expect(result.amount).toBe('1000.0000000');
    expect(result.receivedAmount).toBe(quote('1000').receivedAmount);
  });

  it('handles extreme amounts without overflow or exponent notation', () => {
    const huge = '9'.repeat(40) + '.9999999';
    const result = quote(huge);
    expect(result.exceedsLimit).toBe(true);
    expect(result.amount).toBe('1000.0000000');

    const uncapped = quote(huge, 'USD', 'NGN', { maxAmount: huge });
    expect(uncapped.exceedsLimit).toBe(false);
    expect(uncapped.receivedAmount).not.toMatch(/e/i);
    expect(uncapped.receivedAmount).toMatch(/^\d+\.\d{7}$/);
  });

  it('supports a custom limit and rejects an invalid one', () => {
    expect(quote('60', 'USD', 'NGN', { maxAmount: '50' }).exceedsLimit).toBe(true);
    expect(() => quote('1', 'USD', 'NGN', { maxAmount: '-1' })).toThrow(RangeError);
  });

  it('reports unsupported corridors instead of assuming a 1:1 rate', () => {
    const result = quote('100', 'USD', 'XYZ');
    expect(result.error).toBe('unsupported_corridor');
    expect(result.rate).toBe('0');
    expect(result.amount).toBe('0.0000000');
    expect(result.receivedAmount).toBe('0.0000000');
    expect(result.exceedsLimit).toBe(false);
    // An input error takes precedence over the corridor error.
    expect(quote('-1', 'USD', 'XYZ').error).toBe('negative');
  });

  it('accepts injected rates', () => {
    const result = quote('10', 'USD', 'NGN', { rates: { USD: { NGN: 2.5 } } });
    expect(result.receivedAmount).toBe('24.7500000');
  });
});
