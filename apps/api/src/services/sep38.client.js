'use strict';

const axios = require('axios');
const config = require('../config/env');
const { increment } = require('../observability/metrics');
const { outboundHeaders } = require('../observability/context');
const assetIdentity = require('../wallet/assetIdentity');

const VALID_DECIMAL_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const SEP38_CONTEXTS = Object.freeze(['sep6', 'sep24', 'sep31']);

class Sep38Error extends Error {
  constructor(message, { statusCode = 502, code = 'sep38_error', anchorError = null, details = null } = {}) {
    super(message);
    this.name = 'Sep38Error';
    this.statusCode = statusCode;
    this.code = code;
    this.anchorError = anchorError;
    this.details = details;
  }
}

const normalizeQuoteServerUrl = (url) => {
  const raw = String(url || config?.stellar?.sep38Url || '').trim();
  if (!raw) {
    throw new Sep38Error('SEP-38 quote server URL is required', {
      statusCode: 400,
      code: 'missing_quote_server_url',
    });
  }
  return raw.replace(/\/+$/, '');
};

const normalizeJwt = (jwt) => {
  const token = String(jwt || '').trim().replace(/^Bearer\s+/i, '');
  if (!token) {
    throw new Sep38Error('SEP-10 JWT bearer token is required for SEP-38 firm quotes', {
      statusCode: 401,
      code: 'missing_sep10_jwt',
    });
  }
  return token;
};

const normalizeOptionalJwt = (jwt) => {
  if (!jwt) return null;
  const token = String(jwt).trim().replace(/^Bearer\s+/i, '');
  return token || null;
};

const normalizePositiveDecimal = (value, fieldName) => {
  const raw = String(value ?? '').trim();
  if (!VALID_DECIMAL_RE.test(raw) || !/[1-9]/.test(raw)) {
    throw new Sep38Error(`${fieldName} must be a positive decimal string`, {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }
  return raw;
};

const formatStellarAsset = (code, issuer = null) => {
  const normalizedCode = String(code || '').trim().toUpperCase();
  if (!normalizedCode || normalizedCode === 'XLM' || normalizedCode === 'NATIVE') {
    return 'stellar:native';
  }
  const resolvedIssuer = issuer
    ? String(issuer).trim()
    : assetIdentity.resolveConfiguredIssuer({
      network: config?.stellar?.network || 'testnet',
      code: normalizedCode,
    });

  if (!resolvedIssuer) {
    throw new Sep38Error(`Issuer is required for Stellar asset ${normalizedCode}`, {
      statusCode: 400,
      code: 'missing_asset_issuer',
    });
  }
  return `stellar:${normalizedCode}:${resolvedIssuer}`;
};

const formatFiatAsset = (currency) => {
  const code = String(currency || '').trim().toUpperCase();
  if (!/^[A-Z]{3,4}$/.test(code)) {
    throw new Sep38Error(`Invalid ISO-4217 fiat currency code: ${currency}`, {
      statusCode: 400,
      code: 'invalid_asset',
    });
  }
  return `iso4217:${code}`;
};

const toSep38AssetId = (input, { issuer = null } = {}) => {
  const raw = String(input || '').trim();
  if (!raw) {
    throw new Sep38Error('Asset identifier cannot be empty', {
      statusCode: 400,
      code: 'invalid_asset',
    });
  }

  if (raw.startsWith('stellar:') || raw.startsWith('iso4217:')) {
    return raw;
  }

  const upper = raw.toUpperCase();
  if (upper === 'XLM' || upper === 'NATIVE') {
    return 'stellar:native';
  }

  const configuredIssuer = issuer || assetIdentity.resolveConfiguredIssuer({
    network: config?.stellar?.network || 'testnet',
    code: upper,
  });
  if (configuredIssuer) {
    return formatStellarAsset(upper, configuredIssuer);
  }

  return formatFiatAsset(upper);
};

const parseSep38AssetId = (assetId) => {
  const raw = String(assetId || '').trim();
  if (raw === 'stellar:native') {
    return { scheme: 'stellar', code: 'XLM', issuer: null, isNative: true };
  }
  const parts = raw.split(':');
  if (parts[0] === 'stellar' && parts.length === 3 && parts[1] && parts[2]) {
    return { scheme: 'stellar', code: parts[1].toUpperCase(), issuer: parts[2], isNative: false };
  }
  if (parts[0] === 'iso4217' && parts.length === 2 && parts[1]) {
    return { scheme: 'iso4217', code: parts[1].toUpperCase(), issuer: null, isNative: false };
  }
  throw new Sep38Error(`Invalid SEP-38 asset identifier: ${assetId}`, {
    statusCode: 400,
    code: 'invalid_asset',
  });
};

const assertValidContext = (context) => {
  const normalized = String(context || 'sep31').trim().toLowerCase();
  if (!SEP38_CONTEXTS.includes(normalized)) {
    throw new Sep38Error(`Invalid SEP-38 context: ${context}. Must be one of: ${SEP38_CONTEXTS.join(', ')}`, {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }
  return normalized;
};

const wrapAxiosError = (error, operation) => {
  if (error instanceof Sep38Error) return error;

  const status = error?.response?.status;
  const data = error?.response?.data;
  const anchorError = data?.error || data?.message || null;

  if (status === 401 || status === 403) {
    return new Sep38Error(anchorError || `SEP-38 ${operation} requires valid SEP-10 authentication`, {
      statusCode: status,
      code: 'sep38_unauthorized',
      anchorError,
      details: data || null,
    });
  }

  if (status === 404) {
    return new Sep38Error(anchorError || 'SEP-38 quote not found', {
      statusCode: 404,
      code: 'sep38_quote_not_found',
      anchorError,
      details: data || null,
    });
  }

  if (status) {
    return new Sep38Error(anchorError || `SEP-38 ${operation} failed with status ${status}`, {
      statusCode: status,
      code: 'sep38_anchor_error',
      anchorError,
      details: data || null,
    });
  }

  return new Sep38Error(`SEP-38 ${operation} network error: ${error?.message || 'unknown error'}`, {
    statusCode: 502,
    code: 'sep38_network_error',
  });
};

const getInfo = async ({ quoteServerUrl, jwt } = {}, options = {}) => {
  const baseUrl = normalizeQuoteServerUrl(quoteServerUrl);
  const axiosImpl = options.axiosImpl || axios;
  const timeout = Number(options.timeoutMs ?? config?.requestLimits?.upstreamTimeoutMs ?? 10000);
  const token = normalizeOptionalJwt(jwt);

  try {
    const response = await axiosImpl.get(`${baseUrl}/info`, {
      headers: {
        ...outboundHeaders(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeout,
    });
    increment('sendam_sep38_requests_total', { operation: 'info', result: 'success' });
    return response.data || {};
  } catch (error) {
    const wrapped = wrapAxiosError(error, 'info');
    increment('sendam_sep38_requests_total', { operation: 'info', result: wrapped.code });
    throw wrapped;
  }
};

const getPrices = async (
  {
    quoteServerUrl,
    sellAsset,
    buyAsset,
    sellAmount,
    buyAmount,
    sellDeliveryMethod,
    buyDeliveryMethod,
    countryCode,
    jwt,
  } = {},
  options = {},
) => {
  const baseUrl = normalizeQuoteServerUrl(quoteServerUrl);
  const hasSell = sellAmount !== undefined && sellAmount !== null && sellAmount !== '';
  const hasBuy = buyAmount !== undefined && buyAmount !== null && buyAmount !== '';

  if (hasSell === hasBuy) {
    throw new Sep38Error('Provide exactly one of sellAmount or buyAmount for SEP-38 /prices', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }

  if (hasSell && !sellAsset) {
    throw new Sep38Error('sellAsset is required when sellAmount is provided', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }
  if (hasBuy && !buyAsset) {
    throw new Sep38Error('buyAsset is required when buyAmount is provided', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }

  const params = {
    ...(sellAsset ? { sell_asset: String(sellAsset).trim() } : {}),
    ...(buyAsset ? { buy_asset: String(buyAsset).trim() } : {}),
    ...(hasSell ? { sell_amount: normalizePositiveDecimal(sellAmount, 'sellAmount') } : {}),
    ...(hasBuy ? { buy_amount: normalizePositiveDecimal(buyAmount, 'buyAmount') } : {}),
    ...(sellDeliveryMethod ? { sell_delivery_method: sellDeliveryMethod } : {}),
    ...(buyDeliveryMethod ? { buy_delivery_method: buyDeliveryMethod } : {}),
    ...(countryCode ? { country_code: countryCode } : {}),
  };

  const axiosImpl = options.axiosImpl || axios;
  const timeout = Number(options.timeoutMs ?? config?.requestLimits?.upstreamTimeoutMs ?? 10000);
  const token = normalizeOptionalJwt(jwt);

  try {
    const response = await axiosImpl.get(`${baseUrl}/prices`, {
      params,
      headers: {
        ...outboundHeaders(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeout,
    });
    increment('sendam_sep38_requests_total', { operation: 'prices', result: 'success' });
    return response.data || {};
  } catch (error) {
    const wrapped = wrapAxiosError(error, 'prices');
    increment('sendam_sep38_requests_total', { operation: 'prices', result: wrapped.code });
    throw wrapped;
  }
};

const getPrice = async (
  {
    quoteServerUrl,
    sellAsset,
    buyAsset,
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
  const baseUrl = normalizeQuoteServerUrl(quoteServerUrl);
  if (!sellAsset || !buyAsset) {
    throw new Sep38Error('Both sellAsset and buyAsset are required for SEP-38 /price', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }

  const hasSell = sellAmount !== undefined && sellAmount !== null && sellAmount !== '';
  const hasBuy = buyAmount !== undefined && buyAmount !== null && buyAmount !== '';
  if (hasSell === hasBuy) {
    throw new Sep38Error('Provide exactly one of sellAmount or buyAmount for SEP-38 /price', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }

  const validContext = assertValidContext(context);
  const params = {
    sell_asset: String(sellAsset).trim(),
    buy_asset: String(buyAsset).trim(),
    context: validContext,
    ...(hasSell ? { sell_amount: normalizePositiveDecimal(sellAmount, 'sellAmount') } : {}),
    ...(hasBuy ? { buy_amount: normalizePositiveDecimal(buyAmount, 'buyAmount') } : {}),
    ...(sellDeliveryMethod ? { sell_delivery_method: sellDeliveryMethod } : {}),
    ...(buyDeliveryMethod ? { buy_delivery_method: buyDeliveryMethod } : {}),
    ...(countryCode ? { country_code: countryCode } : {}),
  };

  const axiosImpl = options.axiosImpl || axios;
  const timeout = Number(options.timeoutMs ?? config?.requestLimits?.upstreamTimeoutMs ?? 10000);
  const token = normalizeOptionalJwt(jwt);

  let data;
  try {
    const response = await axiosImpl.get(`${baseUrl}/price`, {
      params,
      headers: {
        ...outboundHeaders(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeout,
    });
    data = response.data || {};
    increment('sendam_sep38_requests_total', { operation: 'price', result: 'success' });
  } catch (error) {
    const wrapped = wrapAxiosError(error, 'price');
    increment('sendam_sep38_requests_total', { operation: 'price', result: wrapped.code });
    throw wrapped;
  }

  return {
    totalPrice: normalizePositiveDecimal(data.total_price, 'total_price'),
    price: normalizePositiveDecimal(data.price, 'price'),
    sellAmount: normalizePositiveDecimal(data.sell_amount, 'sell_amount'),
    buyAmount: normalizePositiveDecimal(data.buy_amount, 'buy_amount'),
    sellAsset: String(sellAsset).trim(),
    buyAsset: String(buyAsset).trim(),
    fee: data.fee || { total: '0', asset: String(sellAsset).trim() },
    context: validContext,
    raw: data,
  };
};

const normalizeFirmQuoteResponse = (data, { fallbackContext = null, now = new Date() } = {}) => {
  const anchorQuoteId = String(data?.id || '').trim();
  if (!anchorQuoteId) {
    throw new Sep38Error('SEP-38 firm quote response is missing id', {
      statusCode: 502,
      code: 'invalid_anchor_response',
      details: data,
    });
  }

  const expiresAt = new Date(data?.expires_at);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new Sep38Error('SEP-38 firm quote response has invalid expires_at timestamp', {
      statusCode: 502,
      code: 'invalid_anchor_response',
      details: data,
    });
  }

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (expiresAt.getTime() <= nowMs) {
    throw new Sep38Error('SEP-38 anchor returned an already-expired firm quote', {
      statusCode: 502,
      code: 'sep38_quote_expired',
      details: data,
    });
  }

  return {
    anchorQuoteId,
    expiresAt,
    expiresAtIso: expiresAt.toISOString(),
    totalPrice: normalizePositiveDecimal(data.total_price, 'total_price'),
    price: normalizePositiveDecimal(data.price, 'price'),
    sellAsset: String(data.sell_asset || '').trim(),
    sellAmount: normalizePositiveDecimal(data.sell_amount, 'sell_amount'),
    buyAsset: String(data.buy_asset || '').trim(),
    buyAmount: normalizePositiveDecimal(data.buy_amount, 'buy_amount'),
    fee: data.fee || { total: '0', asset: data.sell_asset || null },
    context: data.context || fallbackContext || null,
    raw: data,
  };
};

const createFirmQuote = async (
  {
    quoteServerUrl,
    jwt,
    sellAsset,
    buyAsset,
    sellAmount,
    buyAmount,
    context = 'sep31',
    expireAfter,
    sellDeliveryMethod,
    buyDeliveryMethod,
    countryCode,
  } = {},
  options = {},
) => {
  const baseUrl = normalizeQuoteServerUrl(quoteServerUrl);
  const token = normalizeJwt(jwt);

  if (!sellAsset || !buyAsset) {
    throw new Sep38Error('Both sellAsset and buyAsset are required to request a SEP-38 firm quote', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }

  const hasSell = sellAmount !== undefined && sellAmount !== null && sellAmount !== '';
  const hasBuy = buyAmount !== undefined && buyAmount !== null && buyAmount !== '';
  if (hasSell === hasBuy) {
    throw new Sep38Error('Provide exactly one of sellAmount or buyAmount for SEP-38 /quote', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }

  const validContext = assertValidContext(context);
  let expireAfterIso = null;
  if (expireAfter) {
    const parsedExpire = new Date(expireAfter);
    if (Number.isNaN(parsedExpire.getTime())) {
      throw new Sep38Error('expireAfter must be a valid ISO timestamp or Date', {
        statusCode: 400,
        code: 'invalid_parameter',
      });
    }
    expireAfterIso = parsedExpire.toISOString();
  }

  const body = {
    sell_asset: String(sellAsset).trim(),
    buy_asset: String(buyAsset).trim(),
    context: validContext,
    ...(hasSell ? { sell_amount: normalizePositiveDecimal(sellAmount, 'sellAmount') } : {}),
    ...(hasBuy ? { buy_amount: normalizePositiveDecimal(buyAmount, 'buyAmount') } : {}),
    ...(expireAfterIso ? { expire_after: expireAfterIso } : {}),
    ...(sellDeliveryMethod ? { sell_delivery_method: sellDeliveryMethod } : {}),
    ...(buyDeliveryMethod ? { buy_delivery_method: buyDeliveryMethod } : {}),
    ...(countryCode ? { country_code: countryCode } : {}),
  };

  const axiosImpl = options.axiosImpl || axios;
  const timeout = Number(options.timeoutMs ?? config?.requestLimits?.upstreamTimeoutMs ?? 10000);

  let data;
  try {
    const response = await axiosImpl.post(`${baseUrl}/quote`, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...outboundHeaders(),
      },
      timeout,
    });
    data = response.data || {};
    increment('sendam_sep38_requests_total', { operation: 'create_quote', result: 'success' });
  } catch (error) {
    const wrapped = wrapAxiosError(error, 'create_quote');
    increment('sendam_sep38_requests_total', { operation: 'create_quote', result: wrapped.code });
    throw wrapped;
  }

  return normalizeFirmQuoteResponse(data, {
    fallbackContext: validContext,
    now: options.now || new Date(),
  });
};

const getFirmQuote = async ({ quoteServerUrl, jwt, id } = {}, options = {}) => {
  const baseUrl = normalizeQuoteServerUrl(quoteServerUrl);
  const token = normalizeJwt(jwt);
  const quoteId = String(id || '').trim();
  if (!quoteId) {
    throw new Sep38Error('SEP-38 quote id is required', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }

  const axiosImpl = options.axiosImpl || axios;
  const timeout = Number(options.timeoutMs ?? config?.requestLimits?.upstreamTimeoutMs ?? 10000);

  let data;
  try {
    const response = await axiosImpl.get(`${baseUrl}/quote/${encodeURIComponent(quoteId)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...outboundHeaders(),
      },
      timeout,
    });
    data = response.data || {};
    increment('sendam_sep38_requests_total', { operation: 'get_quote', result: 'success' });
  } catch (error) {
    const wrapped = wrapAxiosError(error, 'get_quote');
    increment('sendam_sep38_requests_total', { operation: 'get_quote', result: wrapped.code });
    throw wrapped;
  }

  return normalizeFirmQuoteResponse(data, { now: options.now || new Date() });
};

module.exports = {
  SEP38_CONTEXTS,
  Sep38Error,
  normalizeQuoteServerUrl,
  formatStellarAsset,
  formatFiatAsset,
  toSep38AssetId,
  parseSep38AssetId,
  getInfo,
  getPrices,
  getPrice,
  createFirmQuote,
  getFirmQuote,
};
