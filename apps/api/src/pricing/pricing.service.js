const axios = require('axios');
const config = require('../config/env');
const { withIdAlias } = require('../common/records');
const { increment: incrementMetric } = require('../observability/metrics');
const { outboundHeaders } = require('../observability/context');
const { assertValidAmount, percentage, convert, getAssetRule, subtract, decimalToRatio, compare } = require('../utils/money');

const normalizeCurrency = (currency) => String(currency || '').trim().toUpperCase();
const providerState = new Map();
const rateCache = new Map();
const defaultPrisma = () => require('../common/prisma');
const writeAuditLog = async (args) => {
  try {
    return await require('../common/audit.service').writeAuditLog(args);
  } catch {
    return null;
  }
};

const assertConfiguredCurrency = (currency) => {
  const code = normalizeCurrency(currency);
  getAssetRule(code);
  const rawConfig = config.pricing?.supportedFiatCurrencies;
  const supportedFiats = Array.isArray(rawConfig)
    ? rawConfig.map((c) => String(c).toUpperCase())
    : (typeof rawConfig === 'string' ? rawConfig.split(',').map((s) => s.trim().toUpperCase()) : ['NGN', 'USD', 'EUR', 'GBP']);
  if (!['XLM', 'USDC'].includes(code) && !supportedFiats.includes(code)) {
    throw new Error(`Unsupported fiat currency: ${code}. Configure SUPPORTED_FIAT_CURRENCIES to enable it.`);
  }
  return code;
};

class PricingProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PricingProviderError';
    this.code = code;
  }
}

const cacheKey = (sourceCurrency, targetCurrency) => `${sourceCurrency}:${targetCurrency}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitterDelay = (attempt) => Math.min(1000, 75 * (2 ** attempt)) + Math.floor(Math.random() * 75);

const applySpread = (rate) => {
  const basisPoints = Number(config.pricing?.spreadBasisPoints ?? 0);
  if (!basisPoints) return decimalToRatio(rate).decimal;
  const { numerator, denominator } = decimalToRatio(rate);
  return decimalToRatio(((Number(numerator) / Number(denominator)) * (1 + basisPoints / 10000)).toString()).decimal;
};

const validateProviderPayload = ({ payload, sourceCurrency, targetCurrency, now = new Date() }) => {
  const rawText = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const match = rawText.match(/"conversion_rate"\s*:\s*([0-9.eE+-]+)/);
  if (!match || !match[1]) {
    incrementMetric('sendam_pricing_provider_failures_total', { provider: 'exchangerate-api', reason: 'invalid_data' });
    throw new PricingProviderError('PRICING_INVALID_DATA', 'Pricing provider response did not include a conversion rate.');
  }

  const rateRatio = decimalToRatio(match[1]);
  const rate = rateRatio.decimal;
  const maxRate = decimalToRatio(config.pricing?.maxRate ?? '1000000000');
  if (rateRatio.numerator * maxRate.denominator > maxRate.numerator * rateRatio.denominator) {
    incrementMetric('sendam_pricing_provider_failures_total', { provider: 'exchangerate-api', reason: 'invalid_data' });
    throw new PricingProviderError('PRICING_IMPLAUSIBLE_RATE', 'Pricing provider returned an implausible conversion rate.');
  }

  const sourceTimestampMatch = rawText.match(/"time_last_update_unix"\s*:\s*(\d+)/);
  const sourceTimestamp = sourceTimestampMatch ? new Date(Number(sourceTimestampMatch[1]) * 1000) : now;
  if (now.getTime() - sourceTimestamp.getTime() > Number(config.pricing?.maxSourceAgeMs ?? 86400000)) {
    incrementMetric('sendam_pricing_provider_failures_total', { provider: 'exchangerate-api', reason: 'stale_data' });
    throw new PricingProviderError('PRICING_STALE_DATA', 'Pricing provider returned stale rate data.');
  }

  return {
    provider: 'exchangerate-api',
    sourceCurrency,
    targetCurrency,
    sourceTimestamp,
    rate,
    spread: String(config.pricing?.spreadBasisPoints ?? 0),
    effectiveRate: applySpread(rate),
    raw: typeof payload === 'string' ? JSON.parse(rawText) : payload,
  };
};

const getCircuit = (provider) => providerState.get(provider) || { failures: 0, openedUntil: 0 };
const recordProviderSuccess = (provider) => providerState.set(provider, { failures: 0, openedUntil: 0 });
const recordProviderFailure = (provider, reason) => {
  const current = getCircuit(provider);
  const failures = current.failures + 1;
  const threshold = Number(config.pricing?.circuitThreshold ?? 3);
  const openedUntil = failures >= threshold ? Date.now() + Number(config.pricing?.circuitCooldownMs ?? 30000) : current.openedUntil;
  providerState.set(provider, { failures, openedUntil });
  incrementMetric('sendam_pricing_provider_failures_total', { provider, reason });
};

const cachedRate = (key, maxAgeMs) => {
  const cached = rateCache.get(key);
  if (!cached || Date.now() - cached.cachedAt.getTime() > maxAgeMs) return null;
  incrementMetric('sendam_pricing_cache_used_total', { provider: cached.provider, freshness: Date.now() - cached.sourceTimestamp.getTime() <= Number(config.pricing?.cacheMaxAgeMs ?? 60000) ? 'fresh' : 'stale' });
  return cached;
};

const fetchExchangeRateQuote = async ({ sourceCurrency = 'NGN', targetCurrency = 'USDC' }) => {
  sourceCurrency = assertConfiguredCurrency(sourceCurrency);
  targetCurrency = assertConfiguredCurrency(targetCurrency);
  if (sourceCurrency === targetCurrency) {
    const now = new Date();
    return { provider: 'identity', sourceCurrency, targetCurrency, sourceTimestamp: now, rate: '1', spread: '0', effectiveRate: '1', raw: { conversion_rate: 1 } };
  }

  if (!config.pricing?.exchangeRateApiKey) {
    return null;
  }

  const provider = 'exchangerate-api';
  const key = cacheKey(sourceCurrency, targetCurrency);
  const fresh = cachedRate(key, Number(config.pricing?.cacheMaxAgeMs ?? 60000));
  if (fresh) return fresh;

  const circuit = getCircuit(provider);
  if (circuit.openedUntil > Date.now()) {
    const stale = cachedRate(key, Number(config.pricing?.staleCacheMaxAgeMs ?? 300000));
    if (stale) return { ...stale, stale: true };
    incrementMetric('sendam_pricing_provider_failures_total', { provider, reason: 'open_circuit' });
    throw new PricingProviderError('PRICING_OPEN_CIRCUIT', 'Pricing provider circuit is open.');
  }

  const attempts = Number(config.pricing?.maxRetries ?? 2) + 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await axios.get(`https://v6.exchangerate-api.com/v6/${config.pricing?.exchangeRateApiKey}/pair/${sourceCurrency}/${targetCurrency}`, {
        timeout: Number(config.pricing?.timeoutMs ?? 3000),
        responseType: 'text',
        headers: outboundHeaders(),
      });
      const quote = validateProviderPayload({ payload: response.data, sourceCurrency, targetCurrency });
      rateCache.set(key, { ...quote, cachedAt: new Date() });
      recordProviderSuccess(provider);
      return quote;
    } catch (error) {
      lastError = error;
      const reason = error?.code === 'ECONNABORTED' || /timeout/i.test(error?.message || '') ? 'timeout' : (error?.code === 'PRICING_INVALID_DATA' || error?.code === 'PRICING_IMPLAUSIBLE_RATE' || error?.code === 'PRICING_STALE_DATA' ? 'invalid_data' : 'unavailable');
      if (attempt < attempts - 1) await sleep(jitterDelay(attempt));
      if (attempt === attempts - 1) recordProviderFailure(provider, reason);
    }
  }

  const stale = cachedRate(key, Number(config.pricing?.staleCacheMaxAgeMs ?? 300000));
  if (stale) return { ...stale, stale: true };
  throw lastError || new PricingProviderError('PRICING_UNAVAILABLE', 'Pricing provider unavailable.');
};

const getExchangeRate = async (args) => {
  const quote = await fetchExchangeRateQuote(args);
  return quote?.effectiveRate || null;
};

const resetPricingPolicyState = () => {
  providerState.clear();
  rateCache.clear();
};

// Quote lifecycle states. All persisted quotes start as `active`. A quote moves
// to `consumed` once its payment settles, `expired`/`orphaned` via reconciliation,
// and `replaced` when a newer quote is issued for the same request (requote).
const QUOTE_STATUS = Object.freeze({
  ACTIVE: 'active',
  CONSUMED: 'consumed',
  EXPIRED: 'expired',
  REPLACED: 'replaced',
  ORPHANED: 'orphaned',
});

// Stable error codes so callers (controllers, CLI, tests) can branch on the
// failure reason instead of parsing message strings.
const QUOTE_ERROR_CODES = Object.freeze({
  NOT_FOUND: 'QUOTE_NOT_FOUND',
  EXPIRED: 'QUOTE_EXPIRED',
  NOT_ACTIVE: 'QUOTE_NOT_ACTIVE',
  OWNERSHIP: 'QUOTE_OWNERSHIP',
  ASSET_PAIR: 'QUOTE_ASSET_PAIR',
  AMOUNT: 'QUOTE_AMOUNT',
  RATE_STALE: 'QUOTE_RATE_STALE',
  ALREADY_USED: 'QUOTE_ALREADY_USED',
});

class QuoteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'QuoteError';
    this.code = code;
  }
}

// Create a quote through the supplied persistence client. Pass `tx` (the active
// Prisma transaction client) so the quote commits atomically with the payment
// transaction — never write a quote through the global client inside a
// transaction, or a later rollback can strand an orphan quote.
//
// `idempotencyKey` makes retries safe: if an active quote already exists for the
// key we return it instead of inserting a duplicate (PostgreSQL UNIQUE conflict
// is handled defensively in case a concurrent retry won the race first).
const createQuote = async ({
  userId,
  sourceCurrency = 'NGN',
  targetCurrency = 'USDC',
  sourceAmount,
  route,
  provider,
  idempotencyKey,
  status = QUOTE_STATUS.ACTIVE,
  expiresAt,
  tx,
}) => {
  const client = tx || defaultPrisma();
  sourceCurrency = assertConfiguredCurrency(sourceCurrency);
  targetCurrency = assertConfiguredCurrency(targetCurrency);
  const normalizedSourceAmount = assertValidAmount(sourceAmount, sourceCurrency);
  const providerQuote = await fetchExchangeRateQuote({ sourceCurrency, targetCurrency });
  const rate = providerQuote?.effectiveRate || null;
  const fee = percentage(normalizedSourceAmount, sourceCurrency, 100);
  const netSourceAmount = subtract(normalizedSourceAmount, fee, sourceCurrency);
  const targetAmount = rate ? convert({ amount: netSourceAmount, sourceAsset: sourceCurrency, targetAsset: targetCurrency, rate }) : undefined;
  const expires = expiresAt || new Date(Date.now() + 5 * 60 * 1000);

  const data = {
    userId,
    sourceCurrency,
    targetCurrency,
    sourceAmount: normalizedSourceAmount,
    targetAmount,
    rate,
    sourceTimestamp: providerQuote?.sourceTimestamp,
    spread: providerQuote?.spread || String(config.pricing?.spreadBasisPoints ?? 0),
    feePolicyVersion: config.pricing?.feePolicyVersion || 'standard-v1',
    fee,
    provider: provider || providerQuote?.provider,
    providerResponse: providerQuote ? {
      provider: providerQuote.provider,
      sourceCurrency,
      targetCurrency,
      rate: providerQuote.rate,
      effectiveRate: providerQuote.effectiveRate,
      sourceTimestamp: providerQuote.sourceTimestamp?.toISOString?.() || providerQuote.sourceTimestamp,
      stale: Boolean(providerQuote.stale),
      raw: providerQuote.raw,
    } : undefined,
    route,
    status,
    expiresAt: expires,
    metadata: {
      provenance: {
        provider: provider || providerQuote?.provider || null,
        sourceTimestamp: providerQuote?.sourceTimestamp?.toISOString?.() || null,
        rate,
        spread: providerQuote?.spread || String(config.pricing?.spreadBasisPoints ?? 0),
        feePolicyVersion: config.pricing?.feePolicyVersion || 'standard-v1',
        expiresAt: expires.toISOString(),
      },
    },
  };

  if (idempotencyKey) {
    try {
      const quote = await client.quote.create({ data: { ...data, idempotencyKey } });
      return withIdAlias(quote);
    } catch (error) {
      if (error?.code === 'P2002' && Array.isArray(error?.meta?.target) && error.meta.target.includes('idempotencyKey')) {
        // A concurrent retry already inserted this key. Return that quote (any
        // status) so the caller dedups against the same record instead of
        // erroring — the transaction idempotency check upstream handles the
        // rest.
        const existing = await client.quote.findFirst({ where: { idempotencyKey } });
        if (existing) return withIdAlias(existing);
      }
      throw error;
    }
  }

  const quote = await client.quote.create({ data });
  return withIdAlias(quote);
};

// Validate that a quote may be settled right now. Throws QuoteError on any
// failure (expired, mismatched ownership/asset-pair/amount, stale rate). The
// quote must be loaded inside the active transaction and passed here so the
// check and the subsequent write are consistent.
const validateQuoteForExecution = async ({ quote, userId, asset, amount }) => {
  if (!quote) {
    incrementMetric('sendam_quote_rejected_total', { reason: 'not_found' });
    throw new QuoteError(QUOTE_ERROR_CODES.NOT_FOUND, 'Quote not found.');
  }

  if (quote.status === QUOTE_STATUS.CONSUMED || quote.status === QUOTE_STATUS.REPLACED || quote.status === QUOTE_STATUS.ORPHANED) {
    incrementMetric('sendam_quote_rejected_total', { reason: 'not_active' });
    throw new QuoteError(QUOTE_ERROR_CODES.NOT_ACTIVE, `Quote is ${quote.status} and cannot be submitted.`);
  }

  if (new Date(quote.expiresAt).getTime() <= Date.now()) {
    incrementMetric('sendam_quote_rejected_total', { reason: 'expired' });
    throw new QuoteError(QUOTE_ERROR_CODES.EXPIRED, 'Quote has expired.');
  }

  if (quote.userId == null || String(quote.userId) !== String(userId)) {
    incrementMetric('sendam_quote_rejected_total', { reason: 'ownership' });
    throw new QuoteError(QUOTE_ERROR_CODES.OWNERSHIP, 'Quote does not belong to this user.');
  }

  if (quote.sourceCurrency !== asset || quote.targetCurrency !== asset) {
    incrementMetric('sendam_quote_rejected_total', { reason: 'asset_pair' });
    throw new QuoteError(QUOTE_ERROR_CODES.ASSET_PAIR, 'Quote asset pair does not match the payment.');
  }

  if (compare(quote.sourceAmount, amount, asset) !== 0) {
    incrementMetric('sendam_quote_rejected_total', { reason: 'amount' });
    throw new QuoteError(QUOTE_ERROR_CODES.AMOUNT, 'Quote amount does not match the payment.');
  }

  // Re-check the rate so a quote captured before a rate move cannot be settled
  // at the stale price. Skipped when the rate source is unavailable (e.g. no
  // API key in tests) so availability of pricing never blocks a payment.
  const expectedRate = await getExchangeRate({ sourceCurrency: quote.sourceCurrency, targetCurrency: quote.targetCurrency });
  if (expectedRate != null && quote.rate != null && String(quote.rate) !== String(expectedRate)) {
    incrementMetric('sendam_quote_rejected_total', { reason: 'rate_stale' });
    throw new QuoteError(QUOTE_ERROR_CODES.RATE_STALE, 'Quote rate is no longer valid.');
  }

  return quote;
};

// Issue a fresh quote to replace an expired/rejected one. Safe under retries:
// if the old quote is already `replaced` we return the existing replacement,
// and if it was already `consumed` we refuse (it settled a payment). The new
// quote is written through the same client (so it can join a caller's
// transaction atomically) and the old quote is marked `replaced`.
const requote = async ({ userId, quoteId, tx, emit = true } = {}) => {
  const client = tx || defaultPrisma();
  const stale = await client.quote.findUnique({ where: { id: quoteId } });
  if (!stale) {
    throw new QuoteError(QUOTE_ERROR_CODES.NOT_FOUND, 'Quote not found.');
  }
  if (String(stale.userId) !== String(userId)) {
    throw new QuoteError(QUOTE_ERROR_CODES.OWNERSHIP, 'Quote does not belong to this user.');
  }
  if (stale.status === QUOTE_STATUS.CONSUMED) {
    throw new QuoteError(QUOTE_ERROR_CODES.ALREADY_USED, 'Quote already used; cannot requote.');
  }
  if (stale.status === QUOTE_STATUS.REPLACED && stale.replacedById) {
    const existing = await client.quote.findUnique({ where: { id: stale.replacedById } });
    if (existing) return withIdAlias(existing);
  }

  const fresh = await createQuote({
    userId: stale.userId,
    sourceCurrency: stale.sourceCurrency,
    targetCurrency: stale.targetCurrency,
    sourceAmount: stale.sourceAmount,
    route: stale.route,
    provider: stale.provider,
    tx: client,
  });

  // Mark the old quote replaced only if it hasn't already moved (concurrent
  // requote safety). updateMany with a guarded where avoids clobbering a
  // concurrently-consumed quote.
  await client.quote.updateMany({
    where: { id: stale.id, status: { in: [QUOTE_STATUS.ACTIVE, QUOTE_STATUS.EXPIRED] } },
    data: { status: QUOTE_STATUS.REPLACED, replacedById: fresh.id },
  });

  if (emit) {
    await writeAuditLog({
      actorType: 'user',
      actorId: String(userId),
      action: 'quote.requoted',
      entityType: 'Quote',
      entityId: String(fresh.id),
      metadata: { replacedQuoteId: String(stale.id), reason: stale.status === QUOTE_STATUS.EXPIRED ? 'expired' : 'manual' },
    }).catch(() => {});
    incrementMetric('sendam_quote_requoted_total', { reason: stale.status === QUOTE_STATUS.EXPIRED ? 'expired' : 'manual' });
  }

  return fresh;
};

// Reconcile existing quotes: close any `active` quote past its expiry, and
// close `active` quotes that were never attached to a transaction (orphans from
// prior bugs where the quote committed outside the payment transaction). Emits
// audit + metrics so expiration/cleanup is observable.
const reconcileQuotes = async ({ prismaClient, now = new Date(), orphanGraceMs = 60 * 60 * 1000, emit = true } = {}) => {
  const client = prismaClient || defaultPrisma();

  const expired = await client.quote.updateMany({
    where: { status: QUOTE_STATUS.ACTIVE, expiresAt: { lt: now } },
    data: { status: QUOTE_STATUS.EXPIRED },
  });

  const orphanCutoff = new Date(now.getTime() - orphanGraceMs);
  const orphans = await client.quote.findMany({
    where: { status: QUOTE_STATUS.ACTIVE, createdAt: { lt: orphanCutoff }, transactions: { none: {} } },
    select: { id: true },
  });
  const orphaned = orphans.length
    ? await client.quote.updateMany({ where: { id: { in: orphans.map((o) => o.id) } }, data: { status: QUOTE_STATUS.ORPHANED } })
    : { count: 0 };

  if (emit && (expired.count > 0 || orphaned.count > 0)) {
    await writeAuditLog({
      actorType: 'system',
      action: 'quote.reconciled',
      entityType: 'Quote',
      metadata: { expired: expired.count, orphaned: orphaned.count },
    }).catch(() => {});
    if (expired.count > 0) incrementMetric('sendam_quote_expired_total', { reason: 'reconciliation' }, expired.count);
    if (orphaned.count > 0) incrementMetric('sendam_quote_expired_total', { reason: 'orphaned' }, orphaned.count);
  }

  return { expired: expired.count, orphaned: orphaned.count };
};

module.exports = {
  createQuote,
  getExchangeRate,
  fetchExchangeRateQuote,
  validateProviderPayload,
  resetPricingPolicyState,
  assertConfiguredCurrency,
  validateQuoteForExecution,
  requote,
  reconcileQuotes,
  QuoteError,
  PricingProviderError,
  QUOTE_STATUS,
  QUOTE_ERROR_CODES,
};
