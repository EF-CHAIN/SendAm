// Pure quote maths for the landing-page currency calculator. Kept separate
// from the component so it can be unit-tested and memoised without touching
// React state.

import { EXCHANGE_RATES } from '@/lib/currencyConstants.js';

// SendAm charges a flat 1%.
export const SENDAM_FEE_RATE = 0.01;
export const SENDAM_FEE_PERCENT = 1;

// Traditional bank wire / money transfer fees typically range from 6% to 8%.
export const TRADITIONAL_FEE_RATE = 0.07;
export const TRADITIONAL_FEE_PERCENT = 7;

/**
 * Turn the raw text of the amount field into a safe, non-negative number.
 * Anything that is not a finite number (empty string, ".", "abc") becomes 0.
 */
export function parseAmount(raw) {
  const value = parseFloat(raw);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Compute every figure the calculator displays for one corridor.
 * An unknown corridor falls back to a 1:1 rate so the UI never shows NaN.
 */
export function computeQuote(rawAmount, sourceCurrency, targetCurrency) {
  const amount = parseAmount(rawAmount);

  const sendAmFee = amount * SENDAM_FEE_RATE;
  const netSendAmount = Math.max(0, amount - sendAmFee);
  const traditionalFee = amount * TRADITIONAL_FEE_RATE;

  const rate = EXCHANGE_RATES[sourceCurrency]?.[targetCurrency] || 1;
  const receivedAmount = netSendAmount * rate;

  const estimatedSavings = Math.max(0, traditionalFee - sendAmFee);
  const estimatedSavingsInTarget = estimatedSavings * rate;

  return {
    amount,
    sendAmFee,
    traditionalFee,
    netSendAmount,
    rate,
    receivedAmount,
    estimatedSavings,
    estimatedSavingsInTarget,
  };
}
