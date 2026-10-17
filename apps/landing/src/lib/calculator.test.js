import { describe, expect, it } from 'vitest';
import { calculateQuote, getRate, sendCommand, SENDAM_FEE_PERCENT, TRADITIONAL_FEE_PERCENT } from './calculator.js';
import { EXCHANGE_RATES } from './currencyConstants.js';

describe('getRate', () => {
  it('returns the indicative rate for every published corridor', () => {
    for (const [source, targets] of Object.entries(EXCHANGE_RATES)) {
      for (const [target, rate] of Object.entries(targets)) {
        expect(getRate(source, target)).toBe(rate);
      }
    }
  });

  it('returns null for unknown or invalid corridors instead of a fallback rate', () => {
    expect(getRate('JPY', 'NGN')).toBeNull();
    expect(getRate('USD', 'ZAR')).toBeNull();
    expect(getRate('USD', 'NGN', { USD: { NGN: 0 } })).toBeNull();
    expect(getRate('USD', 'NGN', { USD: { NGN: Number.NaN } })).toBeNull();
  });
});

describe('calculateQuote', () => {
  it('subtracts the flat fee before converting', () => {
    const quote = calculateQuote({ amount: '100', source: 'USD', target: 'NGN' });
    expect(SENDAM_FEE_PERCENT).toBe(1);
    expect(TRADITIONAL_FEE_PERCENT).toBe(7);
    expect(quote.fee).toBe(1);
    expect(quote.net).toBe(99);
    expect(quote.received).toBe(153450);
    expect(quote.traditionalFee).toBe(7);
    expect(quote.savings).toBe(6);
    expect(quote.savingsInTarget).toBe(9300);
  });

  it('converts each corridor with its own rate', () => {
    expect(calculateQuote({ amount: '50', source: 'GBP', target: 'KES' }).received).toBeCloseTo(8167.5, 6);
    expect(calculateQuote({ amount: '250', source: 'EUR', target: 'GHS' }).received).toBeCloseTo(4158, 6);
  });

  it('treats empty, non-numeric and negative input as zero', () => {
    for (const amount of ['', 'abc', '-5', undefined]) {
      const quote = calculateQuote({ amount, source: 'USD', target: 'NGN' });
      expect(quote.amount).toBe(0);
      expect(quote.fee).toBe(0);
      expect(quote.received).toBe(0);
      expect(quote.savings).toBe(0);
    }
  });

  it('reports null payouts for an unavailable corridor', () => {
    const quote = calculateQuote({ amount: '100', source: 'USD', target: 'ZAR' });
    expect(quote.rate).toBeNull();
    expect(quote.received).toBeNull();
    expect(quote.savingsInTarget).toBeNull();
    expect(quote.fee).toBe(1);
  });
});

describe('sendCommand', () => {
  it('builds the WhatsApp command from the typed amount and corridor', () => {
    expect(sendCommand('250', 'GBP', 'KES')).toBe('send 250 GBP to KES');
  });
});
