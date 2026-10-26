import { describe, it, expect } from 'vitest';
import { computeQuote, parseAmount } from './quote.js';
import { EXCHANGE_RATES } from '@/lib/currencyConstants.js';

describe('parseAmount', () => {
  it('parses plain and decimal amounts', () => {
    expect(parseAmount('100')).toBe(100);
    expect(parseAmount('12.5')).toBe(12.5);
  });

  it('returns 0 for empty, partial or non-numeric input', () => {
    expect(parseAmount('')).toBe(0);
    expect(parseAmount('.')).toBe(0);
    expect(parseAmount('abc')).toBe(0);
    expect(parseAmount(undefined)).toBe(0);
  });

  it('never returns a negative or non-finite number', () => {
    expect(parseAmount('-50')).toBe(0);
    expect(parseAmount('Infinity')).toBe(0);
  });
});

describe('computeQuote', () => {
  it('applies the flat 1% fee and the corridor rate (happy path)', () => {
    const q = computeQuote('100', 'USD', 'NGN');
    expect(q.sendAmFee).toBeCloseTo(1);
    expect(q.traditionalFee).toBeCloseTo(7);
    expect(q.netSendAmount).toBeCloseTo(99);
    expect(q.rate).toBe(EXCHANGE_RATES.USD.NGN);
    expect(q.receivedAmount).toBeCloseTo(99 * EXCHANGE_RATES.USD.NGN);
    expect(q.estimatedSavings).toBeCloseTo(6);
    expect(q.estimatedSavingsInTarget).toBeCloseTo(6 * EXCHANGE_RATES.USD.NGN);
  });

  it('returns all zeros for an empty amount', () => {
    const q = computeQuote('', 'USD', 'NGN');
    expect(q.receivedAmount).toBe(0);
    expect(q.sendAmFee).toBe(0);
    expect(q.estimatedSavings).toBe(0);
  });

  it('falls back to a 1:1 rate for an unknown corridor instead of NaN', () => {
    const q = computeQuote('100', 'XXX', 'YYY');
    expect(q.rate).toBe(1);
    expect(q.receivedAmount).toBeCloseTo(99);
    expect(Number.isNaN(q.receivedAmount)).toBe(false);
  });

  it('is deterministic so memoising on its inputs is safe', () => {
    expect(computeQuote('250', 'EUR', 'KES')).toEqual(computeQuote('250', 'EUR', 'KES'));
  });
});
