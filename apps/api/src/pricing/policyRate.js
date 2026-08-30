const config = require('../config/env');
const { increment: incrementMetric } = require('../observability/metrics');
const { outboundHeaders } = require('../observability/context');
const { assertValidAmount, convert, decimalToRatio, getAssetRule } = require('../utils/money');

const POLICY_ERROR_CODES = Object.freeze({
  FX_UNAVAILABLE: 'POLICY_FX_UNAVAILABLE',
  FX_STALE: 'POLICY_FX_STALE',
  DAILY_TOTAL_INCOMPLETE: 'POLICY_DAILY_TOTAL_INCOMPLETE',
});

const COINGECKO_ASSET_IDS = Object.freeze({
  XLM: 'stellar',
});

const FIAT_SOURCES = new Set(['USD', 'EUR', 'GBP']);

class PolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
    this.statusCode = 503;
  }
}

const gcd = (left, right) => {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
};

const ratioToDecimal = (numerator, denominator, maxFractionDigits = 18) => {
  const divisor = gcd(numerator, denominator);
  const num = numerator / divisor;
  const den = denominator / divisor;
  const whole = num / den;
  const rem = num % den;
  if (rem === 0n) return whole.toString();

  const scale = 10n ** BigInt(maxFractionDigits);
  const scaled = rem * scale;
  let fracUnits = scaled / den;
  const remainder = scaled % den;
  if (remainder * 2n >= den) fracUnits += 1n;
  if (fracUnits >= scale) return (whole + 1n).toString();

  const frac = fracUnits.toString().padStart(maxFractionDigits, '0').replace(/0+$/, '');
  return frac.length ? `${whole}.${frac}` : whole.toString();
};

const multiplyDecimalRates = (left, right) => {
  const a = decimalToRatio(left);
  const b = decimalToRatio(right);
  return ratioToDecimal(a.numerator * b.numerator, a.denominator * b.denominator);
};

const toTimestamp = (value) => {
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : NaN;
};

const throwUnavailable = (detail) => {
  incrementMetric('sendam_policy_fx_unavailable_total', { reason: detail || 'unknown' });
  throw new PolicyError(
    POLICY_ERROR_CODES.FX_UNAVAILABLE,
    'Pricing is unavailable; this payment cannot be evaluated against compliance limits.',
  );
};

const throwStale = () => {
  incrementMetric('sendam_policy_fx_stale_total');
  throw new PolicyError(
    POLICY_ERROR_CODES.FX_STALE,
    'Pricing is stale; this payment cannot be evaluated against compliance limits.',
  );
};

const assertFresh = (fetchedAt, now, maxAgeMs) => {
  const fetchedMs = toTimestamp(fetchedAt);
  const nowMs = toTimestamp(now);
  if (!Number.isFinite(fetchedMs) || !Number.isFinite(nowMs)) throwStale();
  if (nowMs - fetchedMs > maxAgeMs) throwStale();
};

const parsePositiveRate = (value) => {
  try {
    return decimalToRatio(value).decimal;
  } catch (_error) {
    return null;
  }
};

const defaultFetchFiatRate = async ({ sourceCurrency, targetCurrency, now }) => {
  const getExchangeRate = require('./pricing.service').getExchangeRate;
  if (sourceCurrency !== targetCurrency && !config.pricing?.exchangeRateApiKey) {
    return null;
  }
  try {
    const rate = await getExchangeRate({ sourceCurrency, targetCurrency });
    if (rate == null) return null;
    return { rate: parsePositiveRate(rate), fetchedAt: now };
  } catch (_error) {
    return null;
  }
};

const defaultFetchCryptoUsdRate = async ({ asset, now }) => {
  const coinId = COINGECKO_ASSET_IDS[asset];
  if (!coinId) return null;
  if (!config.pricing?.coinGeckoApiKey) return null;

  const baseUrl = String(config.pricing.coinGeckoBaseUrl || 'https://api.coingecko.com/api/v3').replace(/\/$/, '');
  const isPro = baseUrl.includes('pro-api.coingecko.com');
  const headers = {
    ...outboundHeaders(),
    ...(isPro
      ? { 'x-cg-pro-api-key': config.pricing.coinGeckoApiKey }
      : { 'x-cg-demo-api-key': config.pricing.coinGeckoApiKey }),
  };

  try {
    const axios = require('axios');
    const response = await axios.get(`${baseUrl}/simple/price`, {
      timeout: config.pricing.coinGeckoTimeoutMs || 10000,
      headers,
      params: { ids: coinId, vs_currencies: 'usd' },
    });
    const usd = response?.data?.[coinId]?.usd;
    const rate = parsePositiveRate(String(usd));
    if (!rate) return null;
    return { rate, fetchedAt: now };
  } catch (_error) {
    return null;
  }
};

const snapshot = ({
  referenceCurrency,
  sourceAsset,
  sourceAmount,
  rate,
  source,
  fetchedAt,
  maxAgeMs,
  policyVersion,
}) => Object.freeze({
  referenceCurrency,
  sourceAsset,
  sourceAmount,
  rate,
  convertedAmount: convert({
    amount: sourceAmount,
    sourceAsset,
    targetAsset: referenceCurrency,
    rate,
  }),
  source,
  fetchedAt: fetchedAt instanceof Date ? fetchedAt.toISOString() : String(fetchedAt),
  maxAgeMs,
  policyVersion,
});

const getPolicyConversionSnapshot = async ({
  sourceAsset,
  amount,
  now = new Date(),
  fetchFiatRate = defaultFetchFiatRate,
  fetchCryptoUsdRate = defaultFetchCryptoUsdRate,
} = {}) => {
  const referenceCurrency = String(config.compliance?.policyCurrency || 'NGN').trim().toUpperCase();
  getAssetRule(referenceCurrency);
  const asset = String(sourceAsset || referenceCurrency).trim().toUpperCase();
  getAssetRule(asset);
  const sourceAmount = assertValidAmount(amount, asset);
  const maxAgeMs = Number(config.compliance?.policyFxMaxAgeMs || 300000);
  const policyVersion = String(config.compliance?.policyVersion || '1');
  const clock = now instanceof Date ? now : new Date(now);

  if (asset === referenceCurrency) {
    return snapshot({
      referenceCurrency,
      sourceAsset: asset,
      sourceAmount,
      rate: '1',
      source: 'identity',
      fetchedAt: clock,
      maxAgeMs,
      policyVersion,
    });
  }

  if (asset === 'USDC' || FIAT_SOURCES.has(asset)) {
    const fiatSource = asset === 'USDC' ? 'USD' : asset;
    let quote;
    try {
      quote = await fetchFiatRate({ sourceCurrency: fiatSource, targetCurrency: referenceCurrency, now: clock });
    } catch (error) {
      if (error instanceof PolicyError) throw error;
      throwUnavailable(asset === 'USDC' ? 'usdc_peg' : 'fiat');
    }
    if (!quote || !quote.rate) throwUnavailable(asset === 'USDC' ? 'usdc_peg' : 'fiat');
    assertFresh(quote.fetchedAt || clock, clock, maxAgeMs);
    return snapshot({
      referenceCurrency,
      sourceAsset: asset,
      sourceAmount,
      rate: quote.rate,
      source: 'exchangerate-api',
      fetchedAt: quote.fetchedAt || clock,
      maxAgeMs,
      policyVersion,
    });
  }

  if (COINGECKO_ASSET_IDS[asset]) {
    let cryptoQuote;
    let fiatQuote;
    try {
      cryptoQuote = await fetchCryptoUsdRate({ asset, now: clock });
    } catch (error) {
      if (error instanceof PolicyError) throw error;
      throwUnavailable('coingecko');
    }
    if (!cryptoQuote || !cryptoQuote.rate) throwUnavailable('coingecko');
    try {
      fiatQuote = await fetchFiatRate({ sourceCurrency: 'USD', targetCurrency: referenceCurrency, now: clock });
    } catch (error) {
      if (error instanceof PolicyError) throw error;
      throwUnavailable('fiat');
    }
    if (!fiatQuote || !fiatQuote.rate) throwUnavailable('fiat');
    assertFresh(cryptoQuote.fetchedAt || clock, clock, maxAgeMs);
    assertFresh(fiatQuote.fetchedAt || clock, clock, maxAgeMs);
    const rate = multiplyDecimalRates(cryptoQuote.rate, fiatQuote.rate);
    if (!parsePositiveRate(rate)) throwUnavailable('composite');
    const fetchedAt = new Date(Math.min(
      toTimestamp(cryptoQuote.fetchedAt || clock),
      toTimestamp(fiatQuote.fetchedAt || clock),
    ));
    return snapshot({
      referenceCurrency,
      sourceAsset: asset,
      sourceAmount,
      rate,
      source: 'composite:coingecko+exchangerate-api',
      fetchedAt,
      maxAgeMs,
      policyVersion,
    });
  }

  throwUnavailable('unsupported_asset');
};

module.exports = {
  getPolicyConversionSnapshot,
  PolicyError,
  POLICY_ERROR_CODES,
  multiplyDecimalRates,
};
