import { describe, expect, it } from 'vitest';
import { formatCurrency } from '@shared/formatCurrency.js';

describe('formatCurrency', () => {
  it.each([
    [0, 'USD', '$0.00'],
    [12, 'USD', '$12.00'],
    [1234.5, 'USD', '$1,234.50'],
    [1.005, 'USD', '$1.01'],
    [-1.005, 'USD', '-$1.01'],
    ['999.995', 'USD', '$1,000.00'],
    [12, 'EUR', '€12.00'],
    [12.345, 'EUR', '€12.35'],
    [0, 'NGN', '₦0.00'],
    [1234.5, 'NGN', '₦1,234.50'],
    ['1.005', 'NGN', '₦1.01'],
    [12.345, 'GBP', '£12.35'],
    [12.5, 'JPY', '¥13'],
    [1.2345, 'KWD', 'KWD\u00a01.235'],
    [0, 'XLM', '0 XLM'],
    [12, 'XLM', '12 XLM'],
    [1234.5, 'XLM', '1,234.5 XLM'],
    [0.0000001, 'XLM', '0.0000001 XLM'],
    ['1.12345674', 'XLM', '1.1234567 XLM'],
    ['1.12345675', 'XLM', '1.1234568 XLM'],
    ['-1.12345675', 'XLM', '-1.1234568 XLM'],
    ['999.99999995', 'XLM', '1,000 XLM'],
    ['1.2300000', 'USDC', '1.23 USDC'],
    ['0.0000001', 'USDC', '0.0000001 USDC'],
    ['123456789.1234567', 'USDC', '123,456,789.1234567 USDC'],
    ['9007199254740993.1234567', 'XLM', '9,007,199,254,740,993.1234567 XLM'],
    [1.12345678, 'BTC', '1.1234568 BTC'],
    [1.12345678, 'TOKEN1234567', '1.1234568 TOKEN1234567'],
    [12.5, ' usd ', '$12.50'],
    [' 12.50 ', ' usdc ', '12.5 usdc'],
    ['1.1234567', 'Token', '1.1234567 Token'],
    ['1.1234567', 'TOKEN', '1.1234567 TOKEN'],
    ['1.1234567', 'token', '1.1234567 token'],
    [-0, 'USD', '$0.00'],
    ['-0.0000000', 'XLM', '0 XLM'],
    ['-0.001', 'USD', '$0.00'],
    ['-0.00000001', 'XLM', '0 XLM'],
    ['922337203685.4775807', 'XLM', '922,337,203,685.4775807 XLM'],
  ])('formats %s %s as %s', (amount, code, expected) => {
    expect(formatCurrency(amount, code)).toBe(expected);
  });

  it.each([
    undefined, null, '', ' ', NaN, Infinity, -Infinity, 'NaN', 'Infinity',
    true, false, [], {}, 1n, '1,000', '$1.00', '12oops', '0x10', '1e3',
    '1.2.3', '1' + '0'.repeat(309),
  ])('rejects invalid amount %s rather than displaying a zero balance', (amount) => {
    expect(() => formatCurrency(amount, 'USD')).toThrow(TypeError);
  });

  it.each([undefined, null, '', ' ', 123, {}, 'US D', '$USD', 'XLM:issuer', 'TOKEN12345678'])('rejects invalid currency code %s', (code) => {
    expect(() => formatCurrency(1, code)).toThrow(TypeError);
  });
});
