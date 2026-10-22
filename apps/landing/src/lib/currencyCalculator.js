// Pure quote calculation for the landing-page CurrencyCalculator.
//
// All arithmetic runs on BigInt fixed-point integers with 7 decimal places,
// the precision of a Stellar amount (1 stroop = 0.0000001). Floating point is
// never used for money, so results carry no binary rounding error. Values are
// rounded half-up to 7 decimals only where a division happens (fees and the
// exchange-rate multiplication).

import { EXCHANGE_RATES } from './currencyConstants.js';

export const CRYPTO_DECIMALS = 7;
const SCALE = 10n ** BigInt(CRYPTO_DECIMALS);

/** SendAm fee: 1% (100 basis points). */
export const SENDAM_FEE_BPS = 100n;
/** Typical bank wire / money transfer fee used for comparison: 7%. */
export const TRADITIONAL_FEE_BPS = 700n;
const BPS_DENOMINATOR = 10_000n;

/**
 * Largest amount quoted per transfer, in source-currency units. Mirrors the
 * API's default `MAX_SEND_AMOUNT` (apps/api/src/config/env.js).
 */
export const MAX_TRANSFER_AMOUNT = '1000';

const DECIMAL_PATTERN = /^(\d+)(?:\.(\d*))?$/;

/**
 * Parses a user-entered amount into fixed-point units.
 *
 * Returns `{ units, error }`. `units` is always a non-negative BigInt; `error`
 * is `null` for a usable amount, otherwise one of `'empty'`, `'invalid'`,
 * `'negative'` or `'too_precise'` (more than 7 decimals), in which case
 * `units` is `0n`.
 */
export function parseAmount(input) {
  if (input === null || input === undefined) return { units: 0n, error: 'empty' };
  const text = String(input).trim();
  if (text === '' || text === '.') return { units: 0n, error: 'empty' };
  if (text.startsWith('-')) return { units: 0n, error: 'negative' };
  const match = DECIMAL_PATTERN.exec(text.startsWith('.') ? `0${text}` : text);
  if (!match) return { units: 0n, error: 'invalid' };
  const [, whole, fraction = ''] = match;
  if (fraction.length > CRYPTO_DECIMALS) return { units: 0n, error: 'too_precise' };
  const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(CRYPTO_DECIMALS, '0'));
  return { units, error: null };
}

/** Converts a decimal string or finite number to fixed-point units. Throws on bad input. */
export function toUnits(value) {
  const text = typeof value === 'number' ? numberToPlainString(value) : value;
  const { units, error } = parseAmount(text);
  if (error) throw new RangeError(`Cannot convert ${String(value)} to units: ${error}`);
  return units;
}

/** Formats fixed-point units as a decimal string with exactly 7 decimals. */
export function formatUnits(units) {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / SCALE;
  const fraction = (abs % SCALE).toString().padStart(CRYPTO_DECIMALS, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** Rate for a corridor as a decimal string, or `null` when unsupported. */
export function getRate(sourceCurrency, targetCurrency, rates = EXCHANGE_RATES) {
  const rate = rates?.[sourceCurrency]?.[targetCurrency];
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return null;
  return numberToPlainString(rate);
}

/**
 * Builds a full quote. Amounts are returned as 7-decimal strings so callers
 * decide how to round for display; use `Number(...)` only for presentation.
 */
export function calculateQuote({
  amount,
  sourceCurrency,
  targetCurrency,
  rates = EXCHANGE_RATES,
  maxAmount = MAX_TRANSFER_AMOUNT,
}) {
  const parsed = parseAmount(amount);
  const maxUnits = toUnits(maxAmount);
  const rateText = getRate(sourceCurrency, targetCurrency, rates);
  const exceedsLimit = parsed.units > maxUnits;
  const quotedUnits = rateText === null ? 0n : exceedsLimit ? maxUnits : parsed.units;
  const rateUnits = rateText === null ? 0n : toUnits(rateText);

  const fee = applyBps(quotedUnits, SENDAM_FEE_BPS);
  const traditionalFee = applyBps(quotedUnits, TRADITIONAL_FEE_BPS);
  const netAmount = quotedUnits - fee;
  const savings = traditionalFee - fee;

  let error = parsed.error;
  if (error === null && rateText === null) error = 'unsupported_corridor';

  return {
    amount: formatUnits(quotedUnits),
    rate: rateText ?? '0',
    fee: formatUnits(fee),
    traditionalFee: formatUnits(traditionalFee),
    netAmount: formatUnits(netAmount),
    receivedAmount: formatUnits(multiply(netAmount, rateUnits)),
    savings: formatUnits(savings),
    savingsInTarget: formatUnits(multiply(savings, rateUnits)),
    exceedsLimit,
    maxAmount: formatUnits(maxUnits),
    error,
  };
}

function applyBps(units, bps) {
  return roundHalfUp(units * bps, BPS_DENOMINATOR);
}

function multiply(left, right) {
  return roundHalfUp(left * right, SCALE);
}

// Inputs here are never negative.
function roundHalfUp(numerator, denominator) {
  return (numerator + denominator / 2n) / denominator;
}

function numberToPlainString(value) {
  if (!Number.isFinite(value)) return 'invalid';
  // Avoid exponent notation (1e-7, 1e21) so the decimal parser can read it.
  return value.toLocaleString('en-US', {
    useGrouping: false,
    maximumFractionDigits: CRYPTO_DECIMALS + 13,
  });
}
