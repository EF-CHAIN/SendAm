'use strict';

// Multi-provider FX rate engine.
//
// A single FX feed is a single point of failure: when ExchangeRate-API is slow
// or down every quote fails, and when its data goes stale every quote is priced
// against an old rate. This module queries three independent sources in
// parallel, takes the median of the fresh responses (which is resistant to one
// bad feed), and refuses any feed older than the configured freshness window
// (60s by default). Each provider has its own circuit breaker so a dead source
// is skipped instead of adding latency to every quote, and operators are
// alerted when a stale/rejected feed or a full outage is detected.
//
// Providers:
//   - exchangerate-api  direct pair, any supported fiat/crypto code
//   - coingecko         crypto priced in fiat (USDC/XLM/BTC/ETH)
//   - binance-p2p       peer-to-peer USDT price in a fiat, composed for
//                       fiat<->fiat and fiat<->stablecoin pairs
//
// The returned `rate` means: units of `targetCurrency` per one unit of
// `sourceCurrency`.

const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');
const { increment } = require('../observability/metrics');
const { outboundHeaders } = require('../observability/context');
const { decimalToRatio } = require('../utils/money');

const PROVIDERS = Object.freeze({
  EXCHANGE_RATE: 'exchangerate-api',
  COINGECKO: 'coingecko',
  BINANCE_P2P: 'binance-p2p',
});

const AGGREGATED_PROVIDER = 'median';

const FX_ERROR_CODES = Object.freeze({
  ALL_PROVIDERS_FAILED: 'FX_ALL_PROVIDERS_FAILED',
  OPEN_CIRCUIT: 'FX_OPEN_CIRCUIT',
  NO_FRESH_RATE: 'FX_NO_FRESH_RATE',
  UNSUPPORTED_PAIR: 'FX_UNSUPPORTED_PAIR',
});

// Stablecoins are treated as interchangeable for rate composition on the P2P
// feed only. The peg assumption is already used elsewhere in pricing
// (USDC -> USD) and is what lets the P2P source contribute to NGN/USDC quotes.
const STABLECOINS = new Set(['USDT', 'USDC']);
const COINGECKO_ASSET_IDS = Object.freeze({
  XLM: 'stellar',
  USDC: 'usd-coin',
  BTC: 'bitcoin',
  ETH: 'ethereum',
});

class FxProviderError extends Error {
  constructor(code, message, { provider, reason } = {}) {
    super(message);
    this.name = 'FxProviderError';
    this.code = code;
    this.provider = provider;
    this.reason = reason;
  }
}

class FxAggregatorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FxAggregatorError';
    this.code = code;
    this.details = details;
    this.statusCode = 503;
  }
}

const providerState = new Map();
const quoteCache = new Map();
const lastAlertAt = new Map();

const normalizeCurrency = (currency) => String(currency || '').trim().toUpperCase();
const cacheKey = (sourceCurrency, targetCurrency) => `${sourceCurrency}:${targetCurrency}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isPositiveNumber = (value) => Number.isFinite(value) && value > 0;
const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
};

// Round to 12 decimal places without exponent notation so the result is a valid
// decimal rate for utils/money and the database.
const formatRate = (value) => {
  const fixed = Number(value).toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  return fixed === '' || fixed === '-0' ? '0' : fixed;
};

const isPlausibleRate = (value) => {
  try {
    return decimalToRatio(value).decimal !== '0';
  } catch (_error) {
    return false;
  }
};

const maxRate = () => Number(config.pricing?.maxRate ?? '1000000000');
const providerTimeoutMs = () => Number(config.pricing?.timeoutMs ?? 3000);
const maxRateAgeMs = () => Number(config.pricing?.fxMaxRateAgeMs ?? 60000);
const minProviders = () => Math.max(1, Number(config.pricing?.fxMinProviders ?? 1));

/**
 * Median of numeric rates. Even-sized samples average the two middle values.
 */
const median = (values) => {
  const sorted = values.filter(isPositiveNumber).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

/**
 * Spread between the cheapest and most expensive candidate in basis points.
 * Used for observability/alerting; the median itself is not adjusted.
 */
const disagreementBps = (values) => {
  const usable = values.filter(isPositiveNumber);
  if (usable.length < 2) return 0;
  const low = Math.min(...usable);
  const high = Math.max(...usable);
  if (low <= 0) return 0;
  return Math.round(((high - low) / low) * 10000);
};

// ── Circuit breaker ────────────────────────────────────────────────────────

const getCircuit = (provider) => providerState.get(provider) || { failures: 0, openedUntil: 0 };
const isCircuitOpen = (provider) => getCircuit(provider).openedUntil > Date.now();

const recordProviderSuccess = (provider) => providerState.set(provider, { failures: 0, openedUntil: 0 });

const recordProviderFailure = (provider, reason) => {
  const current = getCircuit(provider);
  const failures = current.failures + 1;
  const threshold = Number(config.pricing?.circuitThreshold ?? 3);
  const cooldownMs = Number(config.pricing?.circuitCooldownMs ?? 30000);
  const openedUntil = failures >= threshold ? Date.now() + cooldownMs : current.openedUntil;
  providerState.set(provider, { failures, openedUntil });
  increment('sendam_pricing_provider_failures_total', { provider, reason: reason || 'unavailable' });
};

// ── Operator alerting ──────────────────────────────────────────────────────

const alertSettings = () => ({
  url: config.pricing?.fxAlertWebhookUrl
    || config.observability?.errorMonitorWebhookUrl
    || '',
  token: config.pricing?.fxAlertToken || config.observability?.errorMonitorToken,
  timeoutMs: Number(config.observability?.errorMonitorTimeoutMs ?? 3000),
});

const shouldAlert = (key) => {
  const cooldownMs = Number(config.pricing?.fxAlertCooldownMs ?? 60000);
  const previous = lastAlertAt.get(key) || 0;
  if (Date.now() - previous < cooldownMs) return false;
  lastAlertAt.set(key, Date.now());
  return true;
};

/**
 * Notify operators over the configured webhook. Never throws: FX alerting must
 * not take down quoting.
 */
const sendOperatorAlert = async ({ reason, message, details = {} }, deps = {}) => {
  increment('sendam_fx_alerts_total', { reason, status: 'raised' });
  const { url, token, timeoutMs } = alertSettings();
  if (!url) {
    increment('sendam_fx_alerts_total', { reason, status: 'skipped' });
    return { sent: false, reason: 'no_webhook_configured' };
  }
  if (!shouldAlert(`${reason}:${details.pair || ''}`)) {
    increment('sendam_fx_alerts_total', { reason, status: 'throttled' });
    return { sent: false, reason: 'throttled' };
  }
  const post = deps.post || (axios.post ? axios.post.bind(axios) : null);
  if (!post) {
    increment('sendam_fx_alerts_total', { reason, status: 'skipped' });
    return { sent: false, reason: 'no_http_client' };
  }
  try {
    await post(url, {
      event: `fx.${reason}`,
      severity: details.providers?.length ? 'warning' : 'critical',
      message,
      ...details,
      occurredAt: new Date().toISOString(),
    }, {
      timeout: timeoutMs,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    increment('sendam_fx_alerts_total', { reason, status: 'sent' });
    return { sent: true };
  } catch (error) {
    increment('sendam_fx_alerts_total', { reason, status: 'failed' });
    logger.error('fx_alert_delivery_failed', { reason, message: error?.message || String(error) });
    return { sent: false, reason: 'delivery_failed' };
  }
};

// ── Provider fetchers ──────────────────────────────────────────────────────

const fetchJson = async (url, options = {}) => {
  const response = await axios.get(url, {
    timeout: providerTimeoutMs(),
    headers: outboundHeaders(),
    ...options,
  });
  return response?.data;
};

/**
 * ExchangeRate-API pair endpoint. The API's own `time_last_update_unix` is the
 * daily dataset vintage, not the observation time, so freshness here is the
 * time the response was obtained; the vintage is still checked against the
 * legacy max source age.
 */
const fetchExchangeRateApi = async ({ sourceCurrency, targetCurrency }) => {
  const apiKey = config.pricing?.exchangeRateApiKey;
  if (!apiKey) return null;

  const url = `https://v6.exchangerate-api.com/v6/${apiKey}/pair/${sourceCurrency}/${targetCurrency}`;
  const data = await fetchJson(url, { responseType: 'text' });
  let payload = data;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch (_error) {
      throw new FxProviderError('FX_INVALID_DATA', 'ExchangeRate-API returned non-JSON data.', {
        provider: PROVIDERS.EXCHANGE_RATE,
        reason: 'invalid_data',
      });
    }
  }

  if (payload?.result === 'error') {
    if (payload['error-type'] === 'unsupported-code') return null;
    throw new FxProviderError('FX_PROVIDER_ERROR', `ExchangeRate-API error: ${payload['error-type'] || 'unknown'}`, {
      provider: PROVIDERS.EXCHANGE_RATE,
      reason: 'unavailable',
    });
  }

  const rate = toNumber(payload?.conversion_rate);
  if (!isPositiveNumber(rate)) {
    throw new FxProviderError('FX_INVALID_DATA', 'ExchangeRate-API response did not include a conversion rate.', {
      provider: PROVIDERS.EXCHANGE_RATE,
      reason: 'invalid_data',
    });
  }

  const vintage = Number(payload?.time_last_update_unix);
  if (Number.isFinite(vintage)) {
    const vintageAgeMs = Date.now() - vintage * 1000;
    if (vintageAgeMs > Number(config.pricing?.maxSourceAgeMs ?? 86400000)) {
      throw new FxProviderError('FX_STALE_DATA', 'ExchangeRate-API dataset is too old.', {
        provider: PROVIDERS.EXCHANGE_RATE,
        reason: 'stale_data',
      });
    }
  }

  return {
    provider: PROVIDERS.EXCHANGE_RATE,
    rate: formatRate(rate),
    fetchedAt: new Date(),
    sourceTimestamp: new Date(),
    dataTimestamp: Number.isFinite(vintage) ? new Date(vintage * 1000) : null,
    raw: payload,
  };
};

/**
 * CoinGecko prices a crypto asset in a fiat currency. Fiat<->fiat pairs are not
 * supported and yield null so they do not trip the circuit.
 */
const fetchCoinGecko = async ({ sourceCurrency, targetCurrency }) => {
  const apiKey = config.pricing?.coinGeckoApiKey;
  if (!apiKey) return null;

  const sourceId = COINGECKO_ASSET_IDS[sourceCurrency];
  const targetId = COINGECKO_ASSET_IDS[targetCurrency];
  if (!sourceId && !targetId) return null;
  if (sourceId && targetId) return null;

  const baseUrl = String(config.pricing?.coinGeckoBaseUrl || 'https://api.coingecko.com/api/v3').replace(/\/$/, '');
  const isPro = baseUrl.includes('pro-api.coingecko.com');
  const headers = {
    ...outboundHeaders(),
    ...(isPro
      ? { 'x-cg-pro-api-key': apiKey }
      : { 'x-cg-demo-api-key': apiKey }),
  };

  const coinId = sourceId || targetId;
  const fiat = sourceId ? targetCurrency : sourceCurrency;
  const data = await fetchJson(`${baseUrl}/simple/price`, {
    headers,
    timeout: Number(config.pricing?.coinGeckoTimeoutMs ?? 10000),
    params: { ids: coinId, vs_currencies: fiat.toLowerCase(), include_last_updated_at: true },
  });

  const price = toNumber(data?.[coinId]?.[fiat.toLowerCase()]);
  if (!isPositiveNumber(price)) {
    throw new FxProviderError('FX_INVALID_DATA', 'CoinGecko response did not include a price.', {
      provider: PROVIDERS.COINGECKO,
      reason: 'invalid_data',
    });
  }

  const updatedAt = Number(data?.[coinId]?.last_updated_at);
  const fetchedAt = new Date();
  const sourceTimestamp = Number.isFinite(updatedAt) ? new Date(updatedAt * 1000) : fetchedAt;

  return {
    provider: PROVIDERS.COINGECKO,
    rate: formatRate(sourceId ? price : (1 / price)),
    fetchedAt,
    sourceTimestamp,
    dataTimestamp: sourceTimestamp,
    raw: data,
  };
};

const binanceP2pBaseUrl = () => String(
  config.pricing?.binanceP2pBaseUrl || 'https://p2p.binance.com'
).replace(/\/$/, '');

const fetchBinanceP2pFiatPrice = async ({ fiat, post = axios.post }) => {
  const response = await post(`${binanceP2pBaseUrl()}/bapi/c2c/v2/friendly/c2c/adv/search`, {
    fiat,
    asset: 'USDT',
    tradeType: 'SELL',
    page: 1,
    rows: 5,
    payTypes: [],
  }, {
    timeout: Number(config.pricing?.binanceP2pTimeoutMs ?? providerTimeoutMs()),
    headers: { 'content-type': 'application/json', ...outboundHeaders() },
  });

  const ads = response?.data?.data;
  if (!Array.isArray(ads) || ads.length === 0) {
    throw new FxProviderError('FX_INVALID_DATA', `Binance P2P returned no ${fiat}/USDT ads.`, {
      provider: PROVIDERS.BINANCE_P2P,
      reason: 'invalid_data',
    });
  }

  const prices = ads.map((ad) => toNumber(ad?.adv?.price)).filter(isPositiveNumber);
  const price = median(prices);
  if (!price) {
    throw new FxProviderError('FX_INVALID_DATA', `Binance P2P returned no usable ${fiat}/USDT price.`, {
      provider: PROVIDERS.BINANCE_P2P,
      reason: 'invalid_data',
    });
  }

  return { price, fetchedAt: new Date(), raw: ads.map((ad) => ({ price: ad?.adv?.price, createdAt: ad?.adv?.createTime })) };
};

const fetchBinanceP2p = async ({ sourceCurrency, targetCurrency, post }) => {
  if (config.pricing?.binanceP2pEnabled === false) return null;

  const sourceStable = STABLECOINS.has(sourceCurrency);
  const targetStable = STABLECOINS.has(targetCurrency);
  if (sourceStable && targetStable) {
    return {
      provider: PROVIDERS.BINANCE_P2P,
      rate: '1',
      fetchedAt: new Date(),
      sourceTimestamp: new Date(),
      raw: { assetPair: `${sourceCurrency}/${targetCurrency}` },
    };
  }

  // A stablecoin quote against itself in fiat terms: USDT ~= USD for the P2P
  // cross, which lets USD fiat pairs use the P2P feed too.
  const fiatOf = (currency) => (STABLECOINS.has(currency) ? 'USD' : currency);
  const sourceFiat = fiatOf(sourceCurrency);
  const targetFiat = fiatOf(targetCurrency);
  if (sourceFiat === targetFiat) return null;

  const sourceQuote = await fetchBinanceP2pFiatPrice({ fiat: sourceFiat, post });
  const targetQuote = await fetchBinanceP2pFiatPrice({ fiat: targetFiat, post });
  if (sourceQuote.price <= 0) return null;

  // Source fiat -> USDT (1 / price) -> target fiat (* price).
  return {
    provider: PROVIDERS.BINANCE_P2P,
    rate: formatRate(targetQuote.price / sourceQuote.price),
    fetchedAt: new Date(),
    sourceTimestamp: new Date(Math.min(sourceQuote.fetchedAt.getTime(), targetQuote.fetchedAt.getTime())),
    raw: { source: sourceQuote.raw, target: targetQuote.raw },
  };
};

const DEFAULT_PROVIDERS = Object.freeze([
  { name: PROVIDERS.EXCHANGE_RATE, fetch: fetchExchangeRateApi },
  { name: PROVIDERS.COINGECKO, fetch: fetchCoinGecko },
  { name: PROVIDERS.BINANCE_P2P, fetch: fetchBinanceP2p },
]);

// ── Aggregation ────────────────────────────────────────────────────────────

const checkFreshness = ({ quote, now, maxAgeMs }) => {
  const observedAt = quote?.sourceTimestamp instanceof Date
    ? quote.sourceTimestamp
    : new Date(quote?.sourceTimestamp ?? quote?.fetchedAt ?? now);
  const observedMs = observedAt.getTime();
  if (!Number.isFinite(observedMs)) return { fresh: false, ageMs: Infinity };
  const ageMs = now.getTime() - observedMs;
  return { fresh: ageMs <= maxAgeMs, ageMs };
};

const fetchProviderQuote = async ({ provider, sourceCurrency, targetCurrency, deps }) => {
  if (isCircuitOpen(provider.name)) {
    throw new FxAggregatorError(FX_ERROR_CODES.OPEN_CIRCUIT, `${provider.name} circuit is open.`, {
      provider: provider.name,
    });
  }

  const attempts = Number(config.pricing?.maxRetries ?? 2) + 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const quote = await provider.fetch({ sourceCurrency, targetCurrency, post: deps.post });
      if (quote == null) return null;
      if (!isPlausibleRate(quote.rate) || toNumber(quote.rate) > maxRate()) {
        throw new FxProviderError('FX_IMPLAUSIBLE_RATE', `${provider.name} returned an implausible rate.`, {
          provider: provider.name,
          reason: 'invalid_data',
        });
      }
      recordProviderSuccess(provider.name);
      return quote;
    } catch (error) {
      lastError = error;
      const reason = error instanceof FxProviderError
        ? error.reason
        : (/timeout/i.test(error?.message || '') || error?.code === 'ECONNABORTED' ? 'timeout' : 'unavailable');
      if (attempt < attempts - 1) await sleep(75 * (2 ** attempt));
      if (attempt === attempts - 1) recordProviderFailure(provider.name, reason);
    }
  }

  throw lastError || new FxProviderError('FX_PROVIDER_ERROR', `${provider.name} unavailable.`, {
    provider: provider.name,
    reason: 'unavailable',
  });
};

/**
 * Fetch one pair from every provider in parallel and return the median of the
 * fresh responses.
 *
 * @param {object} options
 * @param {string} options.sourceCurrency
 * @param {string} options.targetCurrency
 * @param {Date} [options.now]
 * @param {Array<{name: string, fetch: Function}>} [options.providers]
 * @param {number} [options.maxAgeMs] - maximum feed age in ms (default 60s)
 * @param {number} [options.minProviders] - minimum fresh feeds required
 * @param {Function} [options.post] - injectable HTTP client for Binance
 * @returns {Promise<object>} aggregated quote
 */
const fetchAggregatedRate = async ({
  sourceCurrency,
  targetCurrency,
  now = new Date(),
  providers = DEFAULT_PROVIDERS,
  maxAgeMs = maxRateAgeMs(),
  minProviders: requiredProviders = minProviders(),
  post,
} = {}) => {
  const source = normalizeCurrency(sourceCurrency);
  const target = normalizeCurrency(targetCurrency);
  if (!source || !target) {
    throw new FxAggregatorError(FX_ERROR_CODES.UNSUPPORTED_PAIR, 'Both source and target currency are required.');
  }
  if (source === target) {
    return {
      provider: 'identity',
      sourceCurrency: source,
      targetCurrency: target,
      sourceTimestamp: now,
      rate: '1',
      providers: [],
      providerCount: 0,
      stale: false,
      disagreementBps: 0,
      raw: { conversion_rate: 1 },
    };
  }

  const key = cacheKey(source, target);
  const settled = await Promise.allSettled(
    providers.map((provider) => fetchProviderQuote({
      provider,
      sourceCurrency: source,
      targetCurrency: target,
      deps: { post },
    }))
  );

  const fresh = [];
  const stale = [];
  const failures = [];
  settled.forEach((result, index) => {
    const name = providers[index]?.name || `provider-${index}`;
    if (result.status === 'rejected') {
      failures.push({ provider: name, code: result.reason?.code, message: result.reason?.message });
      return;
    }
    const quote = result.value;
    if (!quote) return;
    const freshness = checkFreshness({ quote, now, maxAgeMs });
    if (!freshness.fresh) {
      stale.push({ provider: quote.provider || name, ageMs: freshness.ageMs });
      recordProviderFailure(quote.provider || name, 'stale_data');
      return;
    }
    fresh.push({ ...quote, provider: quote.provider || name });
  });

  const pair = `${source}/${target}`;
  if (stale.length) {
    increment('sendam_pricing_stale_feeds_total', { pair });
    sendOperatorAlert({
      reason: 'stale_feed_rejected',
      message: `Rejected ${stale.length} FX feed(s) older than ${maxAgeMs}ms for ${pair}.`,
      details: { pair, stale, maxAgeMs, now: now.toISOString() },
    }, { post }).catch(() => {});
  }

  const openCircuits = failures.filter((failure) => failure.code === FX_ERROR_CODES.OPEN_CIRCUIT);
  const allCircuitsOpen = failures.length > 0
    && failures.every((failure) => failure.code === FX_ERROR_CODES.OPEN_CIRCUIT);

  if (fresh.length < requiredProviders) {
    // Emergency fallback: a recent aggregate (inside the stale-cache window) is
    // returned flagged `stale`, but never as a silent fresh rate.
    const cached = quoteCache.get(key);
    const staleCacheMs = Number(config.pricing?.staleCacheMaxAgeMs ?? 300000);
    if (cached && Date.now() - cached.cachedAt.getTime() <= staleCacheMs) {
      increment('sendam_pricing_stale_cache_used_total', { pair });
      sendOperatorAlert({
        reason: 'all_providers_failed',
        message: `All FX providers failed for ${pair}; serving cached rate from ${cached.cachedAt.toISOString()}.`,
        details: { pair, providers: failures.map((failure) => failure.provider), stale, cachedAt: cached.cachedAt.toISOString() },
      }, { post }).catch(() => {});
      return { ...cached.quote, stale: true, cachedAt: cached.cachedAt };
    }

    sendOperatorAlert({
      reason: 'all_providers_failed',
      message: `All FX providers failed for ${pair}; quoting is unavailable.`,
      details: { pair, providers: failures.map((failure) => failure.provider), failures, stale },
    }, { post }).catch(() => {});

    if (allCircuitsOpen || (failures.length && openCircuits.length === failures.length)) {
      throw new FxAggregatorError(FX_ERROR_CODES.OPEN_CIRCUIT, 'All FX provider circuits are open.', {
        pair,
        providers: failures,
      });
    }
    if (stale.length && failures.length === 0) {
      throw new FxAggregatorError(FX_ERROR_CODES.NO_FRESH_RATE, `All FX feeds for ${pair} were stale.`, {
        pair,
        stale,
      });
    }
    const detail = failures.map((failure) => `${failure.provider}: ${failure.message || 'unavailable'}`).join('; ');
    throw new FxAggregatorError(
      FX_ERROR_CODES.ALL_PROVIDERS_FAILED,
      `All FX providers failed for ${pair}${detail ? ` (${detail})` : ''}.`,
      { pair, failures, stale }
    );
  }

  const values = fresh.map((quote) => toNumber(quote.rate));
  const medianValue = median(values);
  if (!isPositiveNumber(medianValue) || !isPlausibleRate(formatRate(medianValue))) {
    throw new FxAggregatorError(FX_ERROR_CODES.NO_FRESH_RATE, `No usable FX rate for ${pair}.`, { pair });
  }

  const sourceTimestamp = new Date(Math.min(...fresh.map((quote) => {
    const value = quote.sourceTimestamp instanceof Date ? quote.sourceTimestamp : new Date(quote.sourceTimestamp);
    return Number.isFinite(value.getTime()) ? value.getTime() : now.getTime();
  })));

  const quote = {
    provider: `${AGGREGATED_PROVIDER}:${fresh.map((candidate) => candidate.provider).join('+')}`,
    sourceCurrency: source,
    targetCurrency: target,
    sourceTimestamp,
    rate: formatRate(medianValue),
    providers: fresh.map((candidate) => ({
      provider: candidate.provider,
      rate: candidate.rate,
      sourceTimestamp: candidate.sourceTimestamp,
    })),
    providerCount: fresh.length,
    stale: false,
    disagreementBps: disagreementBps(values),
    raw: { providers: fresh.map((candidate) => ({ provider: candidate.provider, raw: candidate.raw })) },
  };

  quoteCache.set(key, { quote, cachedAt: new Date() });

  if (failures.length || quote.disagreementBps > Number(config.pricing?.fxMaxDisagreementBps ?? 200)) {
    const reason = failures.length ? 'partial_provider_failure' : 'provider_disagreement';
    increment('sendam_fx_degraded_total', { pair, reason });
    sendOperatorAlert({
      reason,
      message: failures.length
        ? `${failures.length} FX provider(s) failed for ${pair}; using median of ${fresh.length}.`
        : `FX providers disagree by ${quote.disagreementBps}bps for ${pair}.`,
      details: {
        pair,
        providers: fresh.map((candidate) => candidate.provider),
        failures,
        disagreementBps: quote.disagreementBps,
      },
    }, { post }).catch(() => {});
  }

  return quote;
};

/** Test/ops helper: clear circuit breakers, caches and alert throttles. */
const resetFxAggregatorState = () => {
  providerState.clear();
  quoteCache.clear();
  lastAlertAt.clear();
};

module.exports = {
  PROVIDERS,
  FX_ERROR_CODES,
  FxProviderError,
  FxAggregatorError,
  fetchAggregatedRate,
  fetchExchangeRateApi,
  fetchCoinGecko,
  fetchBinanceP2p,
  fetchBinanceP2pFiatPrice,
  median,
  disagreementBps,
  resetFxAggregatorState,
  sendOperatorAlert,
};
