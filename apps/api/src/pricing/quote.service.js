'use strict';

const config = require('../config/env');
const logger = require('../utils/logger');
const { withIdAlias } = require('../common/records');
const { increment } = require('../observability/metrics');
const { decimalToRatio } = require('../utils/money');
const sep38Client = require('../services/sep38.client');

let pricingService = {};
try {
  pricingService = require('./pricing.service');
} catch (_err) {
  pricingService = {};
}

const QUOTE_STATUS = pricingService.QUOTE_STATUS || Object.freeze({
  ACTIVE: 'active',
  CONSUMED: 'consumed',
  EXPIRED: 'expired',
  REPLACED: 'replaced',
  ORPHANED: 'orphaned',
});

const QUOTE_ERROR_CODES = pricingService.QUOTE_ERROR_CODES || Object.freeze({
  NOT_FOUND: 'QUOTE_NOT_FOUND',
  EXPIRED: 'QUOTE_EXPIRED',
  NOT_ACTIVE: 'QUOTE_NOT_ACTIVE',
  OWNERSHIP: 'QUOTE_OWNERSHIP',
  ASSET_PAIR: 'QUOTE_ASSET_PAIR',
  AMOUNT: 'QUOTE_AMOUNT',
  RATE_STALE: 'QUOTE_RATE_STALE',
  ALREADY_USED: 'QUOTE_ALREADY_USED',
});

const QuoteError = pricingService.QuoteError || class QuoteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'QuoteError';
    this.code = code;
  }
};

const DEFAULT_FIRM_QUOTE_TTL_SECONDS = 60;

const defaultPrisma = () => require('../common/prisma');

const writeAuditLog = async (args) => {
  try {
    return await require('../common/audit.service').writeAuditLog(args);
  } catch {
    return null;
  }
};

const ratiosEqual = (left, right) => {
  try {
    const a = decimalToRatio(left);
    const b = decimalToRatio(right);
    return a.numerator * b.denominator === b.numerator * a.denominator;
  } catch {
    return String(left) === String(right);
  }
};

const isFirmSep38Quote = (quote) => Boolean(
  quote
  && (quote.provider === 'sep38' || (quote.metadata?.firm === true && quote.metadata?.sep38?.anchorQuoteId)),
);

const getCorridorIndicativePrices = async (
  {
    quoteServerUrl,
    sourceCurrency,
    targetCurrency,
    sellAsset,
    buyAsset,
    sourceAmount,
    sellAmount,
    buyAmount,
    context = 'sep31',
    sellDeliveryMethod,
    buyDeliveryMethod,
    countryCode,
    jwt,
  } = {},
  options = {},
) => {
  const resolvedSellAsset = sellAsset || (sourceCurrency ? sep38Client.toSep38AssetId(sourceCurrency) : null);
  const resolvedBuyAsset = buyAsset || (targetCurrency ? sep38Client.toSep38AssetId(targetCurrency) : null);
  const resolvedSellAmount = sellAmount ?? (buyAmount == null ? sourceAmount : undefined);

  if (resolvedSellAsset && resolvedBuyAsset) {
    return sep38Client.getPrice(
      {
        quoteServerUrl,
        sellAsset: resolvedSellAsset,
        buyAsset: resolvedBuyAsset,
        sellAmount: resolvedSellAmount,
        buyAmount,
        context,
        sellDeliveryMethod,
        buyDeliveryMethod,
        countryCode,
        jwt,
      },
      options,
    );
  }

  return sep38Client.getPrices(
    {
      quoteServerUrl,
      sellAsset: resolvedSellAsset,
      buyAsset: resolvedBuyAsset,
      sellAmount: resolvedSellAmount,
      buyAmount,
      sellDeliveryMethod,
      buyDeliveryMethod,
      countryCode,
      jwt,
    },
    options,
  );
};

const createFirmCorridorQuote = async (
  {
    userId,
    sourceCurrency,
    targetCurrency,
    sellAsset,
    buyAsset,
    sourceAmount,
    sellAmount,
    buyAmount,
    context = 'sep31',
    quoteServerUrl,
    jwt,
    lockDurationSeconds,
    sellDeliveryMethod,
    buyDeliveryMethod,
    countryCode,
    route = 'sep38',
    idempotencyKey,
    tx,
    now,
  } = {},
  options = {},
) => {
  const nowDate = now instanceof Date ? now : new Date(now || Date.now());
  const nowMs = nowDate.getTime();

  const ttlSeconds = Number(
    lockDurationSeconds ?? config?.stellar?.sep38DefaultQuoteTtlSeconds ?? DEFAULT_FIRM_QUOTE_TTL_SECONDS,
  );
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new QuoteError(QUOTE_ERROR_CODES.AMOUNT, 'lockDurationSeconds must be greater than zero.');
  }

  const resolvedSellAsset = sellAsset || (sourceCurrency ? sep38Client.toSep38AssetId(sourceCurrency) : null);
  const resolvedBuyAsset = buyAsset || (targetCurrency ? sep38Client.toSep38AssetId(targetCurrency) : null);
  const resolvedSellAmount = sellAmount ?? (buyAmount == null ? sourceAmount : undefined);

  const requestedExpiresAt = new Date(nowMs + ttlSeconds * 1000);
  const firmQuote = await sep38Client.createFirmQuote(
    {
      quoteServerUrl,
      jwt,
      sellAsset: resolvedSellAsset,
      buyAsset: resolvedBuyAsset,
      sellAmount: resolvedSellAmount,
      buyAmount,
      context,
      expireAfter: requestedExpiresAt.toISOString(),
      sellDeliveryMethod,
      buyDeliveryMethod,
      countryCode,
    },
    { ...options, now: nowDate },
  );

  const effectiveExpiryMs = Math.min(firmQuote.expiresAt.getTime(), requestedExpiresAt.getTime());
  if (effectiveExpiryMs <= nowMs) {
    throw new QuoteError(QUOTE_ERROR_CODES.EXPIRED, 'Anchor firm quote expired before lock could be created.');
  }
  const expiresAt = new Date(effectiveExpiryMs);

  const resolvedSourceCode = sourceCurrency
    ? String(sourceCurrency).trim().toUpperCase()
    : sep38Client.parseSep38AssetId(firmQuote.sellAsset || resolvedSellAsset).code;
  const resolvedTargetCode = targetCurrency
    ? String(targetCurrency).trim().toUpperCase()
    : sep38Client.parseSep38AssetId(firmQuote.buyAsset || resolvedBuyAsset).code;

  const feeText = firmQuote.fee?.total != null ? String(firmQuote.fee.total) : '0';
  const client = tx || options.prisma || defaultPrisma();

  const data = {
    userId: userId ?? null,
    sourceCurrency: resolvedSourceCode,
    targetCurrency: resolvedTargetCode,
    sourceAmount: firmQuote.sellAmount,
    targetAmount: firmQuote.buyAmount,
    rate: firmQuote.totalPrice,
    sourceTimestamp: nowDate,
    spread: '0',
    feePolicyVersion: config?.pricing?.feePolicyVersion || 'standard-v1',
    fee: feeText,
    provider: 'sep38',
    providerResponse: {
      provider: 'sep38',
      anchorQuoteId: firmQuote.anchorQuoteId,
      sellAsset: firmQuote.sellAsset || resolvedSellAsset,
      buyAsset: firmQuote.buyAsset || resolvedBuyAsset,
      price: firmQuote.price,
      totalPrice: firmQuote.totalPrice,
      sellAmount: firmQuote.sellAmount,
      buyAmount: firmQuote.buyAmount,
      fee: firmQuote.fee,
      expiresAt: firmQuote.expiresAtIso,
      raw: firmQuote.raw,
    },
    route,
    status: QUOTE_STATUS.ACTIVE,
    expiresAt,
    metadata: {
      firm: true,
      guaranteed: true,
      lockDurationSeconds: ttlSeconds,
      sep38: {
        anchorQuoteId: firmQuote.anchorQuoteId,
        quoteServerUrl: sep38Client.normalizeQuoteServerUrl(quoteServerUrl),
        sellAsset: firmQuote.sellAsset || resolvedSellAsset,
        buyAsset: firmQuote.buyAsset || resolvedBuyAsset,
        sellAmount: firmQuote.sellAmount,
        buyAmount: firmQuote.buyAmount,
        price: firmQuote.price,
        totalPrice: firmQuote.totalPrice,
        fee: firmQuote.fee,
        context: firmQuote.context,
        anchorExpiresAt: firmQuote.expiresAtIso,
      },
    },
  };

  let persisted;
  if (idempotencyKey) {
    try {
      persisted = await client.quote.create({ data: { ...data, idempotencyKey } });
    } catch (error) {
      if (error?.code === 'P2002' && Array.isArray(error?.meta?.target) && error.meta.target.includes('idempotencyKey')) {
        const existing = await client.quote.findFirst({ where: { idempotencyKey } });
        if (existing) persisted = existing;
      }
      if (!persisted) throw error;
    }
  } else {
    persisted = await client.quote.create({ data });
  }

  const aliased = withIdAlias(persisted);
  increment('sendam_sep38_firm_quotes_total', {
    source: resolvedSourceCode,
    target: resolvedTargetCode,
    context,
  });

  await writeAuditLog({
    actorType: userId ? 'user' : 'system',
    actorId: userId ? String(userId) : 'sep38',
    action: 'quote.sep38.firm_created',
    entityType: 'Quote',
    entityId: String(aliased.id),
    metadata: {
      anchorQuoteId: firmQuote.anchorQuoteId,
      sourceCurrency: resolvedSourceCode,
      targetCurrency: resolvedTargetCode,
      sourceAmount: firmQuote.sellAmount,
      targetAmount: firmQuote.buyAmount,
      totalPrice: firmQuote.totalPrice,
      expiresAt: expiresAt.toISOString(),
    },
  }).catch((err) => logger.warn('sep38_quote_audit_failed', { message: err.message }));

  return {
    ...aliased,
    anchorQuoteId: firmQuote.anchorQuoteId,
    firm: true,
    guaranteed: true,
    lockDurationSeconds: ttlSeconds,
    remainingMs: Math.max(0, expiresAt.getTime() - nowMs),
  };
};

const assertFirmQuoteValidForExecution = ({
  quote,
  userId,
  sourceAsset,
  targetAsset = null,
  amount,
  now = new Date(),
} = {}) => {
  if (!quote) {
    increment('sendam_quote_rejected_total', { reason: 'not_found' });
    throw new QuoteError(QUOTE_ERROR_CODES.NOT_FOUND, 'Quote not found.');
  }

  if (quote.status !== QUOTE_STATUS.ACTIVE) {
    increment('sendam_quote_rejected_total', { reason: 'not_active' });
    throw new QuoteError(QUOTE_ERROR_CODES.NOT_ACTIVE, `Quote is ${quote.status} and cannot be submitted.`);
  }

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const localExpiresMs = new Date(quote.expiresAt).getTime();
  const anchorExpiresRaw = quote.metadata?.sep38?.anchorExpiresAt;
  const anchorExpiresMs = anchorExpiresRaw ? new Date(anchorExpiresRaw).getTime() : Infinity;
  const effectiveExpiresMs = Math.min(localExpiresMs, anchorExpiresMs);

  if (!Number.isFinite(localExpiresMs) || effectiveExpiresMs <= nowMs) {
    increment('sendam_quote_rejected_total', { reason: 'expired' });
    throw new QuoteError(QUOTE_ERROR_CODES.EXPIRED, 'Guaranteed firm quote validity window has expired.');
  }

  if (quote.userId == null || String(quote.userId) !== String(userId)) {
    increment('sendam_quote_rejected_total', { reason: 'ownership' });
    throw new QuoteError(QUOTE_ERROR_CODES.OWNERSHIP, 'Quote does not belong to this user.');
  }

  const normalizedSource = String(sourceAsset || '').trim().toUpperCase();
  if (String(quote.sourceCurrency || '').trim().toUpperCase() !== normalizedSource) {
    increment('sendam_quote_rejected_total', { reason: 'asset_pair' });
    throw new QuoteError(QUOTE_ERROR_CODES.ASSET_PAIR, 'Quote source currency does not match the payment.');
  }

  if (targetAsset) {
    const normalizedTarget = String(targetAsset).trim().toUpperCase();
    if (String(quote.targetCurrency || '').trim().toUpperCase() !== normalizedTarget) {
      increment('sendam_quote_rejected_total', { reason: 'asset_pair' });
      throw new QuoteError(QUOTE_ERROR_CODES.ASSET_PAIR, 'Quote target currency does not match the payment.');
    }
  }

  if (!ratiosEqual(quote.sourceAmount, amount)) {
    increment('sendam_quote_rejected_total', { reason: 'amount' });
    throw new QuoteError(QUOTE_ERROR_CODES.AMOUNT, 'Quote amount does not match the payment.');
  }

  return {
    valid: true,
    quote,
    anchorQuoteId: quote.metadata?.sep38?.anchorQuoteId || null,
    remainingMs: Math.max(0, effectiveExpiresMs - nowMs),
  };
};

const consumeFirmQuote = async ({
  quoteId,
  userId,
  sourceAsset,
  targetAsset = null,
  amount,
  now = new Date(),
  tx,
} = {}) => {
  const client = tx || defaultPrisma();
  const quote = await client.quote.findUnique({ where: { id: quoteId } });
  const validation = assertFirmQuoteValidForExecution({
    quote,
    userId,
    sourceAsset,
    targetAsset,
    amount,
    now,
  });

  if (typeof client.quote.updateMany === 'function') {
    const nowDate = now instanceof Date ? now : new Date(now);
    const updated = await client.quote.updateMany({
      where: {
        id: quoteId,
        status: QUOTE_STATUS.ACTIVE,
        expiresAt: { gt: nowDate },
      },
      data: { status: QUOTE_STATUS.CONSUMED },
    });
    if (updated.count === 0) {
      throw new QuoteError(QUOTE_ERROR_CODES.NOT_ACTIVE, 'Firm quote was already consumed or expired.');
    }
    const consumed = await client.quote.findUnique({ where: { id: quoteId } });
    return { ...validation, quote: withIdAlias(consumed || { ...quote, status: QUOTE_STATUS.CONSUMED }) };
  }

  const consumed = await client.quote.update({
    where: { id: quoteId },
    data: { status: QUOTE_STATUS.CONSUMED },
  });
  return { ...validation, quote: withIdAlias(consumed) };
};

const getQuoteWithRemainingWindow = async ({ quoteId, prismaClient = defaultPrisma(), now = new Date() } = {}) => {
  const quote = await prismaClient.quote.findUnique({ where: { id: quoteId } });
  if (!quote) return null;

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const localExpiresMs = new Date(quote.expiresAt).getTime();
  const anchorExpiresRaw = quote.metadata?.sep38?.anchorExpiresAt;
  const anchorExpiresMs = anchorExpiresRaw ? new Date(anchorExpiresRaw).getTime() : Infinity;
  const remainingMs = Math.max(0, Math.min(localExpiresMs, anchorExpiresMs) - nowMs);
  const isExpired = remainingMs <= 0;

  return {
    quote: withIdAlias(quote),
    remainingMs,
    isExpired,
    isExecutable: quote.status === QUOTE_STATUS.ACTIVE && !isExpired,
  };
};

module.exports = {
  DEFAULT_FIRM_QUOTE_TTL_SECONDS,
  QUOTE_STATUS,
  QUOTE_ERROR_CODES,
  QuoteError,
  isFirmSep38Quote,
  getCorridorIndicativePrices,
  createFirmCorridorQuote,
  assertFirmQuoteValidForExecution,
  consumeFirmQuote,
  getQuoteWithRemainingWindow,
};
