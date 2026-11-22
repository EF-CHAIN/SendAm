const ASSET_RULES = Object.freeze({
  XLM: { precision: 7, min: '0.0000001', max: '1000000000', rounding: 'HALF_UP' },
  USDC: { precision: 7, min: '0.0000001', max: '1000000000', rounding: 'HALF_UP' },
  GHS: { precision: 2, min: '0.01', max: '1000000000.00', rounding: 'HALF_UP' },
  NGN: { precision: 2, min: '1.00', max: '5000000000.00', rounding: 'HALF_UP' },
  USD: { precision: 2, min: '0.01', max: '1000000000.00', rounding: 'HALF_UP' },
  EUR: { precision: 2, min: '0.01', max: '1000000000.00', rounding: 'HALF_UP' },
  GBP: { precision: 2, min: '0.01', max: '1000000000.00', rounding: 'HALF_UP' },
});

const DECIMAL_RE = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/;
const EXPONENTIAL_RE = /^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/;

const getAssetRule = (asset = 'XLM') => {
  const code = String(asset || '').trim().toUpperCase();
  const rule = ASSET_RULES[code];
  if (!rule) throw new Error(`Unsupported asset or currency: ${asset}`);
  return { code, ...rule };
};

const parseUnits = (value, precision, { rejectExcessPrecision = true } = {}) => {
  const raw = String(value).trim();
  const match = raw.match(DECIMAL_RE);
  if (!match) throw new Error('Amount must be a positive decimal string.');
  const fractional = match[1] || '';
  if (rejectExcessPrecision && fractional.length > precision) {
    throw new Error(`Amount supports at most ${precision} decimal places.`);
  }
  const padded = fractional.padEnd(precision, '0').slice(0, precision);
  return BigInt(`${raw.split('.')[0]}${padded}`);
};

const formatUnits = (units, precision) => {
  const sign = units < 0n ? '-' : '';
  const abs = units < 0n ? -units : units;
  const scale = 10n ** BigInt(precision);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(precision, '0');
  if (precision === 0) return `${sign}${whole}`;
  return `${sign}${whole}.${frac}`;
};

const assertValidAmount = (value, asset = 'XLM') => {
  const rule = getAssetRule(asset);
  const units = parseUnits(value, rule.precision);
  if (units <= 0n) throw new Error('Amount must be greater than zero.');
  if (units < parseUnits(rule.min, rule.precision)) throw new Error(`Amount is below the ${rule.code} minimum of ${rule.min}.`);
  if (units > parseUnits(rule.max, rule.precision)) throw new Error(`Amount exceeds the ${rule.code} maximum of ${rule.max}.`);
  return formatUnits(units, rule.precision);
};

const expandExponentialDecimal = (value) => {
  const raw = String(value).trim();
  const match = raw.match(EXPONENTIAL_RE);
  if (!match) return raw;

  const [, sign, whole, fractional = '', exponentText] = match;
  const exponent = Number(exponentText);
  const digits = `${whole}${fractional}`.replace(/^0+(?=\d)/, '');
  const decimalPlaces = fractional.length - exponent;

  if (decimalPlaces <= 0) {
    return `${sign}${digits}${'0'.repeat(Math.abs(decimalPlaces))}`;
  }

  if (decimalPlaces >= digits.length) {
    return `${sign}0.${'0'.repeat(decimalPlaces - digits.length)}${digits}`;
  }

  const splitAt = digits.length - decimalPlaces;
  return `${sign}${digits.slice(0, splitAt)}.${digits.slice(splitAt)}`;
};

const decimalToRatio = (value) => {
  const raw = expandExponentialDecimal(value);
  const match = raw.match(DECIMAL_RE);
  if (!match) throw new Error('Rate must be a positive decimal string.');
  const fractional = match[1] || '';
  const numerator = BigInt(`${raw.split('.')[0]}${fractional}`);
  if (numerator <= 0n) throw new Error('Rate must be greater than zero.');
  return { numerator, denominator: 10n ** BigInt(fractional.length), decimal: raw };
};

const multiplyRatio = (units, numerator, denominator) => {
  const product = units * numerator;
  const quotient = product / denominator;
  const remainder = product % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
};

const percentage = (amount, asset, basisPoints) => {
  const rule = getAssetRule(asset);
  const units = parseUnits(amount, rule.precision);
  return formatUnits(multiplyRatio(units, BigInt(basisPoints), 10000n), rule.precision);
};

const convert = ({ amount, sourceAsset, targetAsset, rate }) => {
  const source = getAssetRule(sourceAsset);
  const target = getAssetRule(targetAsset);
  const sourceUnits = parseUnits(amount, source.precision);
  const { numerator, denominator } = decimalToRatio(rate);
  const targetScale = 10n ** BigInt(target.precision);
  const sourceScale = 10n ** BigInt(source.precision);
  return formatUnits(multiplyRatio(sourceUnits * targetScale, numerator, denominator * sourceScale), target.precision);
};

const add = (left, right, asset) => {
  const rule = getAssetRule(asset);
  return formatUnits(parseUnits(left, rule.precision) + parseUnits(right, rule.precision), rule.precision);
};

const subtract = (left, right, asset) => {
  const rule = getAssetRule(asset);
  return formatUnits(parseUnits(left, rule.precision) - parseUnits(right, rule.precision), rule.precision);
};

const compare = (left, right, asset) => {
  const rule = getAssetRule(asset);
  const a = parseUnits(left, rule.precision);
  const b = parseUnits(right, rule.precision);
  return a === b ? 0 : a > b ? 1 : -1;
};

const STROOPS_PER_XLM = 10_000_000n;
const STELLAR_PRECISION = 7;
// Stellar amounts are signed 64-bit stroop integers.
const MAX_STROOPS = 9223372036854775807n;

/**
 * Truncates (never rounds up) a decimal value to `precision` places and returns
 * the canonical fixed-precision string. Unlike parseUnits, excess digits are
 * discarded rather than rejected, so a computed value such as 1/3 can be made
 * Horizon-safe without ever being inflated past what the sender holds.
 * Accepts strings, bigints, finite numbers and exponent notation.
 */
const truncateAmount = (value, precision = STELLAR_PRECISION) => {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('Amount must be a positive decimal string.');
  }
  const raw = expandExponentialDecimal(typeof value === 'number' ? value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 }) : String(value).trim());
  if (!DECIMAL_RE.test(raw)) throw new Error('Amount must be a positive decimal string.');
  return formatUnits(parseUnits(raw, precision, { rejectExcessPrecision: false }), precision);
};

/** Converts a decimal amount to integer stroops, truncating beyond 7 places. */
const toStroops = (value) => {
  const stroops = parseUnits(truncateAmount(value, STELLAR_PRECISION), STELLAR_PRECISION);
  if (stroops > MAX_STROOPS) throw new Error('Amount exceeds the maximum Stellar amount.');
  return stroops;
};

/** Formats integer stroops as the 7-decimal string Horizon expects. */
const fromStroops = (stroops) => {
  let units;
  try {
    units = BigInt(stroops);
  } catch (_error) {
    throw new Error('Stroops must be an integer.');
  }
  if (units < 0n) throw new Error('Stroops must not be negative.');
  if (units > MAX_STROOPS) throw new Error('Amount exceeds the maximum Stellar amount.');
  return formatUnits(units, STELLAR_PRECISION);
};

/**
 * Normalizes any amount into a valid Stellar operation amount: positive,
 * truncated to 7 decimal places, within int64 stroops.
 */
const toStellarAmount = (value) => {
  const stroops = toStroops(value);
  if (stroops <= 0n) throw new Error('Amount must be greater than zero.');
  return fromStroops(stroops);
};

module.exports = {
  ASSET_RULES,
  STROOPS_PER_XLM,
  STELLAR_PRECISION,
  getAssetRule,
  assertValidAmount,
  parseUnits,
  formatUnits,
  percentage,
  convert,
  add,
  subtract,
  compare,
  decimalToRatio,
  expandExponentialDecimal,
  truncateAmount,
  toStroops,
  fromStroops,
  toStellarAmount,
};
