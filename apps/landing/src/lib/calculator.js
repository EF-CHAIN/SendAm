import { EXCHANGE_RATES } from './currencyConstants.js';

// Flat SendAm fee and the typical bank-wire fee shown for comparison.
export const SENDAM_FEE_PERCENT = 1;
export const TRADITIONAL_FEE_PERCENT = 7;

/** Indicative rate for a corridor, or `null` when the corridor is not offered. */
export function getRate(source, target, rates = EXCHANGE_RATES) {
  const rate = rates[source]?.[target];
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * Quote shown by the landing-page calculator. Amounts are in the source
 * currency except `received` and `savingsInTarget`, which are in the target
 * currency. Non-numeric or negative input is treated as zero. For a corridor
 * without a rate, `rate`, `received` and `savingsInTarget` are `null` rather
 * than a silently wrong number.
 */
export function calculateQuote({ amount, source, target, rates = EXCHANGE_RATES }) {
  const parsed = Number.parseFloat(amount);
  const sendAmount = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  const fee = (sendAmount * SENDAM_FEE_PERCENT) / 100;
  const net = Math.max(0, sendAmount - fee);
  const traditionalFee = (sendAmount * TRADITIONAL_FEE_PERCENT) / 100;
  const savings = Math.max(0, traditionalFee - fee);
  const rate = getRate(source, target, rates);
  return {
    amount: sendAmount,
    fee,
    net,
    traditionalFee,
    savings,
    rate,
    received: rate === null ? null : net * rate,
    savingsInTarget: rate === null ? null : savings * rate,
  };
}

/** Message prefilled in the WhatsApp deep link for the current quote. */
export function sendCommand(amount, source, target) {
  return `send ${amount} ${source} to ${target}`;
}
