'use strict';

// Dynamic corridor fee and margin calculator (#997).
//
// A flat percentage fee loses money on micro-payments: the Stellar network fee
// and the off-ramp banking charge are fixed costs that a 1% fee cannot recover
// on a small transfer, so the platform ends up subsidising the payment. Every
// fee is therefore priced with an affine formula and clamped:
//
//   fee = clamp(amount * ratePercentage + baseCost, minFee, maxFee)
//
// `baseCost` is the fixed per-payment cost and doubles as the margin floor: a
// rule is only accepted when `minFee` is strictly greater than `baseCost`, and
// the calculator re-applies that floor itself, so the realised margin
// (`fee - baseCost`) is positive for every transaction size. A fee that would
// equal or exceed the amount is rejected instead of producing a negative or
// zero net — the payment is simply below the smallest chargeable amount.
//
// Rules are matched most-specific-first per corridor: exact `SRC:DST`, then
// `SRC:*`, then `*:DST`, then `*:*`. They are persisted in `FeeRule` and
// edited through the admin API, so pricing can be re-tuned without a deploy.

const config = require('../config/env');
const { getAssetRule, parseUnits, formatUnits } = require('../utils/money');

const WILDCARD = '*';
const RULE_PRECISION = 7;
const MINOR_UNIT = 1n;
const BASIS_POINTS = 10000n;

const FEE_RULE_MATCH = Object.freeze({
  CORRIDOR: 'corridor',
  SOURCE: 'source',
  TARGET: 'target',
  DEFAULT: 'default',
});

const FEE_RULE_ERROR_CODES = Object.freeze({
  INVALID_RULE: 'FEE_RULE_INVALID',
  INVALID_PRICE: 'FEE_RULE_PRICE_INVALID',
  EXCEEDS_AMOUNT: 'FEE_EXCEEDS_AMOUNT',
});

class FeeRuleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FeeRuleError';
    this.code = code;
    this.details = details;
    this.statusCode = 400;
  }
}

const normalizeCurrency = (value, fallback = WILDCARD) => {
  const code = String(value ?? '').trim().toUpperCase();
  return code === '' ? fallback : code;
};

const corridorKey = (sourceCurrency, targetCurrency) => (
  `${normalizeCurrency(sourceCurrency)}:${normalizeCurrency(targetCurrency)}`
);

const precisionOf = (asset) => {
  try {
    return getAssetRule(asset).precision;
  } catch (_error) {
    return RULE_PRECISION;
  }
};

const defaultRateBps = () => {
  const configured = Number(config.pricing?.feeRateBps);
  return Number.isInteger(configured) && configured >= 0 && configured <= 10000 ? configured : 100;
};

// Fallbacks used when no matching FeeRule row exists (fresh database, admin
// API outage, unit tests without a Prisma client). Mirrors the seed rows in
// prisma/migrations/20261124020000_add_fee_rule/migration.sql.
const buildDefaultFeeRules = () => {
  const rateBps = defaultRateBps();
  return [
    // Defaults keep the historical 1% for normal-sized payments and only add a
    // floor for micro-payments. Operators raise baseCost per corridor to recover
    // fixed network/off-ramp charges, and the minFee floor keeps margins positive.
    { sourceCurrency: 'XLM', targetCurrency: WILDCARD, rateBps, baseCost: '0', minFee: '0.0100000', maxFee: null, priority: 10 },
    { sourceCurrency: 'USDC', targetCurrency: WILDCARD, rateBps, baseCost: '0', minFee: '0.0200000', maxFee: null, priority: 10 },
    { sourceCurrency: 'NGN', targetCurrency: WILDCARD, rateBps, baseCost: '0', minFee: '40.00', maxFee: null, priority: 10 },
    { sourceCurrency: 'GHS', targetCurrency: WILDCARD, rateBps, baseCost: '0', minFee: '0.50', maxFee: null, priority: 10 },
    { sourceCurrency: 'USD', targetCurrency: WILDCARD, rateBps, baseCost: '0', minFee: '0.20', maxFee: null, priority: 10 },
    { sourceCurrency: WILDCARD, targetCurrency: WILDCARD, rateBps, baseCost: '0', minFee: '0.20', maxFee: null, priority: 0 },
  ].map((rule, index) => ({
    ...rule,
    id: null,
    version: 0,
    active: true,
    description: 'Built-in default fee schedule',
    source: 'builtin',
    __order: index,
  }));
};

const DEFAULT_FEE_RULES = Object.freeze(buildDefaultFeeRules());

const parseDecimal = (value, field, { asset, allowNull = false } = {}) => {
  if (value === null || value === undefined || value === '') {
    if (allowNull) return null;
    throw new FeeRuleError(FEE_RULE_ERROR_CODES.INVALID_RULE, `${field} is required.`);
  }
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) {
    throw new FeeRuleError(FEE_RULE_ERROR_CODES.INVALID_RULE, `${field} must be a non-negative decimal string.`);
  }
  // Canonicalize to the precision the fee will actually be charged in whenever
  // the rule's currency is a known asset; otherwise validate at rule precision.
  const precision = asset ? precisionOf(asset) : RULE_PRECISION;
  let units;
  try {
    units = parseUnits(text, precision);
  } catch (_error) {
    throw new FeeRuleError(
      FEE_RULE_ERROR_CODES.INVALID_RULE,
      `${field} supports at most ${precision} decimal places for ${asset || 'the configured asset'}.`,
    );
  }
  return formatUnits(units, precision);
};

/**
 * Validate and canonicalize a fee rule (from the admin API, the database or the
 * built-in defaults). Guarantees the margin invariant: minFee > baseCost.
 */
const normalizeFeeRule = (input = {}) => {
  const rateBps = Number(input.rateBps ?? 0);
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) {
    throw new FeeRuleError(FEE_RULE_ERROR_CODES.INVALID_RULE, 'rateBps must be an integer between 0 and 10000.');
  }

  const sourceCurrency = normalizeCurrency(input.sourceCurrency);
  const targetCurrency = normalizeCurrency(input.targetCurrency);
  const feeAsset = sourceCurrency === WILDCARD ? null : sourceCurrency;

  const baseCost = parseDecimal(input.baseCost ?? '0', 'baseCost', { asset: feeAsset });
  const minFee = parseDecimal(input.minFee, 'minFee', { asset: feeAsset });
  const maxFee = parseDecimal(input.maxFee, 'maxFee', { asset: feeAsset, allowNull: true });

  const baseUnits = parseUnits(baseCost, feeAsset ? precisionOf(feeAsset) : RULE_PRECISION);
  const minUnits = parseUnits(minFee, feeAsset ? precisionOf(feeAsset) : RULE_PRECISION);
  if (minUnits <= baseUnits) {
    throw new FeeRuleError(
      FEE_RULE_ERROR_CODES.INVALID_RULE,
      `minFee (${minFee}) must be greater than baseCost (${baseCost}) so every payment keeps a positive margin.`,
    );
  }
  if (maxFee != null) {
    const maxUnits = parseUnits(maxFee, feeAsset ? precisionOf(feeAsset) : RULE_PRECISION);
    if (maxUnits < minUnits) {
      throw new FeeRuleError(
        FEE_RULE_ERROR_CODES.INVALID_RULE,
        `maxFee (${maxFee}) must be greater than or equal to minFee (${minFee}).`,
      );
    }
  }

  const priority = Number(input.priority ?? 0);
  if (!Number.isInteger(priority)) {
    throw new FeeRuleError(FEE_RULE_ERROR_CODES.INVALID_RULE, 'priority must be an integer.');
  }

  return {
    id: input.id ?? null,
    sourceCurrency,
    targetCurrency,
    rateBps,
    baseCost,
    minFee,
    maxFee,
    priority,
    active: input.active === undefined ? true : Boolean(input.active),
    version: Number.isInteger(Number(input.version)) ? Number(input.version) : 1,
    description: input.description ?? null,
    source: input.source || 'database',
    // Preserved through re-normalization so a priced quote can report which
    // tier of the schedule matched it.
    match: input.match ?? null,
  };
};

const specificityOf = (rule, sourceCurrency, targetCurrency) => {
  const source = normalizeCurrency(rule.sourceCurrency);
  const target = normalizeCurrency(rule.targetCurrency);
  const sourceMatches = source === WILDCARD || source === sourceCurrency;
  const targetMatches = target === WILDCARD || target === targetCurrency;
  if (!sourceMatches || !targetMatches) return null;
  if (source !== WILDCARD && target !== WILDCARD) return 0; // exact corridor
  if (source !== WILDCARD) return 1; // source-only
  if (target !== WILDCARD) return 2; // target-only
  return 3; // global fallback
};

const MATCH_BY_SPECIFICITY = [
  FEE_RULE_MATCH.CORRIDOR,
  FEE_RULE_MATCH.SOURCE,
  FEE_RULE_MATCH.TARGET,
  FEE_RULE_MATCH.DEFAULT,
];

/**
 * Pick the rule that applies to a corridor. Most specific match wins; ties are
 * broken by higher `priority`, then the newer rule version, then source order
 * (database rules before built-in defaults).
 */
const resolveFeeRule = ({ rules = [], sourceCurrency, targetCurrency, asset } = {}) => {
  const source = normalizeCurrency(sourceCurrency || asset);
  const target = normalizeCurrency(targetCurrency || source);

  const candidates = rules
    .filter((rule) => rule && rule.active !== false)
    .map((rule, index) => {
      const specificity = specificityOf(rule, source, target);
      if (specificity === null) return null;
      let normalized;
      try {
        normalized = normalizeFeeRule(rule);
      } catch (_error) {
        // A persisted rule that violates the margin invariant must never price
        // a payment; skip it and fall through to the next candidate.
        return null;
      }
      return {
        ...normalized,
        match: MATCH_BY_SPECIFICITY[specificity],
        __specificity: specificity,
        __order: index,
      };
    })
    .filter(Boolean);

  if (!candidates.length) {
    const fallback = DEFAULT_FEE_RULES.find((rule) => specificityOf(rule, source, target) === 3);
    return fallback ? { ...normalizeFeeRule(fallback), match: FEE_RULE_MATCH.DEFAULT } : null;
  }

  candidates.sort((left, right) => (
    left.__specificity - right.__specificity
    || right.priority - left.priority
    || right.version - left.version
    || left.__order - right.__order
  ));

  const winner = candidates[0];
  const { __specificity, __order, ...rule } = winner;
  return rule;
};

const divideRounded = (units, numerator, denominator) => {
  const product = units * numerator;
  const quotient = product / denominator;
  const remainder = product % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
};

/**
 * Price a payment with the clamped tiered formula.
 *
 * @param {object} options
 * @param {string|number} options.amount - gross amount in `asset`
 * @param {string} options.asset - currency the fee is charged in
 * @param {object} options.rule - normalized fee rule (see normalizeFeeRule)
 * @returns {object} fee, clamp state, margin and net amount as decimal strings
 */
const calculateFee = ({ amount, asset, rule } = {}) => {
  const assetRule = getAssetRule(asset);
  const code = assetRule.code;
  const precision = assetRule.precision;

  let amountUnits;
  try {
    amountUnits = parseUnits(String(amount), precision);
  } catch (_error) {
    throw new FeeRuleError(FEE_RULE_ERROR_CODES.INVALID_PRICE, `Amount must be a decimal string with at most ${precision} places.`);
  }
  if (amountUnits <= 0n) {
    throw new FeeRuleError(FEE_RULE_ERROR_CODES.INVALID_PRICE, 'Amount must be greater than zero.');
  }

  const normalized = normalizeFeeRule({ ...(rule || {}), sourceCurrency: rule?.sourceCurrency || code });
  const baseUnits = parseUnits(normalized.baseCost, precision);
  const minUnits = parseUnits(normalized.minFee, precision);
  const maxUnits = normalized.maxFee == null ? null : parseUnits(normalized.maxFee, precision);

  const variableUnits = divideRounded(amountUnits, BigInt(normalized.rateBps), BASIS_POINTS);
  const rawUnits = variableUnits + baseUnits;

  // Margin guarantee, applied independently of the stored rule: the fee can
  // never fall to (or below) the fixed cost, even if a legacy row predates the
  // validation in normalizeFeeRule.
  const floorUnits = minUnits > baseUnits ? minUnits : baseUnits + MINOR_UNIT;
  const capUnits = maxUnits === null ? null : maxUnits;

  let feeUnits = rawUnits;
  let clamped = null;
  if (feeUnits < floorUnits) {
    feeUnits = floorUnits;
    clamped = 'min';
  }
  if (capUnits !== null && feeUnits > capUnits) {
    // A cap below the floor would break the margin invariant; validation
    // rejects such rules, but never let one through silently.
    feeUnits = capUnits < floorUnits ? floorUnits : capUnits;
    clamped = capUnits < floorUnits ? 'min' : 'max';
  }

  if (feeUnits >= amountUnits) {
    throw new FeeRuleError(
      FEE_RULE_ERROR_CODES.EXCEEDS_AMOUNT,
      `Amount ${formatUnits(amountUnits, precision)} ${code} is below the minimum chargeable amount for this corridor (minimum fee ${normalized.minFee} ${code}).`,
      {
        asset: code,
        amount: formatUnits(amountUnits, precision),
        minFee: normalized.minFee,
        minChargeableAmount: formatUnits(floorUnits + MINOR_UNIT, precision),
        ruleId: normalized.id,
        corridor: `${normalized.sourceCurrency}:${normalized.targetCurrency}`,
      },
    );
  }

  const marginUnits = feeUnits - baseUnits;
  return {
    fee: formatUnits(feeUnits, precision),
    currency: code,
    amount: formatUnits(amountUnits, precision),
    netAmount: formatUnits(amountUnits - feeUnits, precision),
    variableFee: formatUnits(variableUnits, precision),
    baseCost: formatUnits(baseUnits, precision),
    minFee: formatUnits(minUnits, precision),
    maxFee: capUnits === null ? null : formatUnits(capUnits, precision),
    clamped,
    margin: formatUnits(marginUnits, precision),
    marginPositive: marginUnits > 0n,
    // Realised fee in basis points (integer math, two decimal places).
    effectiveRateBps: Number((feeUnits * BASIS_POINTS * 100n) / amountUnits) / 100,
    rule: {
      id: normalized.id,
      sourceCurrency: normalized.sourceCurrency,
      targetCurrency: normalized.targetCurrency,
      rateBps: normalized.rateBps,
      baseCost: normalized.baseCost,
      minFee: normalized.minFee,
      maxFee: normalized.maxFee,
      version: normalized.version,
      priority: normalized.priority,
      source: normalized.source,
      match: normalized.match || null,
    },
  };
};

/** Price `amount` with whichever of `rules` matches the corridor. */
const priceWithRules = ({ amount, asset, sourceCurrency, targetCurrency, rules = DEFAULT_FEE_RULES } = {}) => {
  const rule = resolveFeeRule({ rules, sourceCurrency, targetCurrency, asset });
  if (!rule) {
    throw new FeeRuleError(FEE_RULE_ERROR_CODES.INVALID_RULE, `No fee rule configured for ${corridorKey(sourceCurrency, targetCurrency)}.`);
  }
  return calculateFee({ amount, asset, rule });
};

module.exports = {
  WILDCARD,
  FEE_RULE_MATCH,
  FEE_RULE_ERROR_CODES,
  FeeRuleError,
  DEFAULT_FEE_RULES,
  corridorKey,
  normalizeCurrency,
  normalizeFeeRule,
  resolveFeeRule,
  calculateFee,
  priceWithRules,
};
