const { priceLoyaltyFee } = require('./loyaltyRebate');
const config = require('../config/env');
const { withIdAlias } = require('../common/records');
const { increment: incrementMetric } = require('../observability/metrics');
const { assertValidAmount, convert, getAssetRule, subtract, decimalToRatio, compare } = require('../utils/money');
const { fetchAggregatedRate, resetFxAggregatorState, FxAggregatorError, FX_ERROR_CODES } = require('./fxAggregator');

const normalizeCurrency = (currency) => String(currency || '').trim().toUpperCase();
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

const AGGREGATOR_ERROR_CODES = Object.freeze({
  [FX_ERROR_CODES.OPEN_CIRCUIT]: 'PRICING_OPEN_CIRCUIT',
  [FX_ERROR_CODES.NO_FRESH_RATE]: 'PRICING_STALE_DATA',
  [FX_ERROR_CODES.ALL_PROVIDERS_FAILED]: 'PRICING_UNAVAILABLE',
  [FX_ERROR_CODES.UNSUPPORTED_PAIR]: 'PRICING_UNSUPPORTED_PAIR',
});

// FX is served by the multi-provider aggregator (see pricing/fxAggregator.js).
// When no provider credential is configured at all we keep the historical
// behaviour and report pricing as unavailable instead of making public network
// calls (important for tests and local development).
const fetchExchangeRateQuote = async ({ sourceCurrency = 'NGN', targetCurrency = 'USDC' }) => {
  sourceCurrency = assertConfiguredCurrency(sourceCurrency);
  targetCurrency = assertConfiguredCurrency(targetCurrency);
  if (sourceCurrency === targetCurrency) {
    const now = new Date();
    return { provider: 'identity', sourceCurrency, targetCurrency, sourceTimestamp: now, rate: '1', spread: '0', effectiveRate: '1', providers: [], raw: { conversion_rate: 1 } };
  }

  const hasConfiguredProvider = Boolean(config.pricing?.exchangeRateApiKey || config.pricing?.coinGeckoApiKey);
  if (config.pricing?.fxAggregatorEnabled === false || !hasConfiguredProvider) {
    return null;
  }

  let quote;
  try {
    quote = await fetchAggregatedRate({ sourceCurrency, targetCurrency });
  } catch (error) {
    if (error instanceof FxAggregatorError) {
      const code = AGGREGATOR_ERROR_CODES[error.code] || 'PRICING_UNAVAILABLE';
      incrementMetric('sendam_pricing_provider_failures_total', {
        provider: 'aggregator',
        reason: error.code === 'FX_OPEN_CIRCUIT' ? 'open_circuit' : 'unavailable',
      });
      throw new PricingProviderError(code, error.message);
    }
    throw error;
  }

  return {
    ...quote,
    spread: String(config.pricing?.spreadBasisPoints ?? 0),
    effectiveRate: applySpread(quote.rate),
  };
};

const getExchangeRate = async (args) => {
  const quote = await fetchExchangeRateQuote(args);
  return quote?.effectiveRate || null;
};

const resetPricingPolicyState = () => {
  resetFxAggregatorState();
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
  const { fee, loyalty, feeQuote } = await priceLoyaltyFee({
    db: client,
    userId,
    asset: sourceCurrency,
    amount: normalizedSourceAmount,
    targetCurrency,
    detail: true,
  });
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
      ...(loyalty ? { loyalty } : {}),
      // Which corridor rule priced this quote, and how the clamp behaved. Kept
      // with the quote so a fee can always be explained after a rule change.
      ...(feeQuote ? {
        feeBreakdown: {
          ruleId: feeQuote.rule.id,
          corridor: `${feeQuote.rule.sourceCurrency}:${feeQuote.rule.targetCurrency}`,
          match: feeQuote.rule.match,
          rateBps: feeQuote.rule.rateBps,
          baseCost: feeQuote.baseCost,
          minFee: feeQuote.minFee,
          maxFee: feeQuote.maxFee,
          ruleVersion: feeQuote.rule.version,
          clamped: feeQuote.clamped,
          margin: feeQuote.margin,
          marginPositive: feeQuote.marginPositive,
          effectiveRateBps: feeQuote.effectiveRateBps,
        },
      } : {}),
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

  if (quote.provider === 'sep38' || quote.metadata?.firm === true) {
    if (quote.status !== QUOTE_STATUS.ACTIVE) {
      incrementMetric('sendam_quote_rejected_total', { reason: 'not_active' });
      throw new QuoteError(QUOTE_ERROR_CODES.NOT_ACTIVE, `Quote is ${quote.status} and cannot be submitted.`);
    }

    const anchorExpiresRaw = quote.metadata?.sep38?.anchorExpiresAt;
    const anchorExpiresMs = anchorExpiresRaw ? new Date(anchorExpiresRaw).getTime() : Infinity;
    if (Math.min(new Date(quote.expiresAt).getTime(), anchorExpiresMs) <= Date.now()) {
      incrementMetric('sendam_quote_rejected_total', { reason: 'expired' });
      throw new QuoteError(QUOTE_ERROR_CODES.EXPIRED, 'Quote has expired.');
    }

    if (quote.userId == null || String(quote.userId) !== String(userId)) {
      incrementMetric('sendam_quote_rejected_total', { reason: 'ownership' });
      throw new QuoteError(QUOTE_ERROR_CODES.OWNERSHIP, 'Quote does not belong to this user.');
    }

    if (quote.sourceCurrency !== asset) {
      incrementMetric('sendam_quote_rejected_total', { reason: 'asset_pair' });
      throw new QuoteError(QUOTE_ERROR_CODES.ASSET_PAIR, 'Quote asset pair does not match the payment.');
    }

    if (compare(quote.sourceAmount, amount, asset) !== 0) {
      incrementMetric('sendam_quote_rejected_total', { reason: 'amount' });
      throw new QuoteError(QUOTE_ERROR_CODES.AMOUNT, 'Quote amount does not match the payment.');
    }

    return quote;
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

const { getPolicyConversionSnapshot, PolicyError, POLICY_ERROR_CODES } = require('./policyRate');

module.exports = {
  createQuote,
  getExchangeRate,
  fetchExchangeRateQuote,
  validateProviderPayload,
  resetPricingPolicyState,
  getPolicyConversionSnapshot,
  assertConfiguredCurrency,
  validateQuoteForExecution,
  requote,
  reconcileQuotes,
  QuoteError,
  PolicyError,
  PricingProviderError,
  QUOTE_STATUS,
  QUOTE_ERROR_CODES,
  POLICY_ERROR_CODES,
};

