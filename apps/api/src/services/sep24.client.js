'use strict';

const crypto = require('crypto');
const axios = require('axios');
const config = require('../config/env');
const { getRedisConnection } = require('../config/redis');
const whatsappService = require('./whatsapp.service');
const logger = require('../utils/logger');
const { outboundHeaders } = require('../observability/context');

const getDefaultPrisma = () => {
  try {
    return require('../common/prisma');
  } catch (_err) {
    return null;
  }
};

const SHORT_LINK_KEY_PREFIX = 'sep24:shortlink:';
const SESSION_BY_ANCHOR_TX_PREFIX = 'sep24:tx:';
const DEFAULT_SHORT_LINK_TTL_SECONDS = 3600;

const memoryShortLinks = new Map();
const memoryAnchorSessions = new Map();

const SEP24_STATUS_TO_INTERNAL = Object.freeze({
  incomplete: 'pending',
  pending_user_transfer_start: 'pending',
  pending_user_transfer_complete: 'processing',
  pending_external: 'processing',
  pending_anchor: 'processing',
  pending_stellar: 'processing',
  pending_trust: 'pending',
  pending_user: 'pending',
  completed: 'completed',
  refunded: 'refunded',
  expired: 'expired',
  error: 'failed',
  no_market: 'failed',
  too_small: 'failed',
  too_large: 'failed',
});

class Sep24Error extends Error {
  constructor(message, { statusCode = 502, code = 'sep24_error', anchorError = null, details = null } = {}) {
    super(message);
    this.name = 'Sep24Error';
    this.statusCode = statusCode;
    this.code = code;
    this.anchorError = anchorError;
    this.details = details;
  }
}

const normalizeTransferServerUrl = (url) => {
  const raw = String(url || config?.stellar?.sep24Url || '').trim();
  if (!raw) {
    throw new Sep24Error('SEP-24 transfer server URL is required', {
      statusCode: 400,
      code: 'missing_transfer_server_url',
    });
  }
  return raw.replace(/\/+$/, '');
};

const normalizeJwt = (jwt) => {
  const token = String(jwt || '').trim().replace(/^Bearer\s+/i, '');
  if (!token) {
    throw new Sep24Error('SEP-10 JWT bearer token is required for SEP-24 requests', {
      statusCode: 401,
      code: 'missing_sep10_jwt',
    });
  }
  return token;
};

const normalizePublicBaseUrl = (baseUrl) => {
  const raw = String(
    baseUrl
    || config?.stellar?.publicBaseUrl
    || process.env.PUBLIC_BASE_URL
    || `http://localhost:${config?.port || 3002}`,
  ).trim();
  return raw.replace(/\/+$/, '');
};

const getRedisClient = (options = {}) => {
  if (options.redis !== undefined) return options.redis;
  try {
    return getRedisConnection(options.config || config);
  } catch (_err) {
    return null;
  }
};

const setStoreValue = async (redisClient, memoryMap, key, value, ttlSeconds = DEFAULT_SHORT_LINK_TTL_SECONDS) => {
  const safeTtl = Math.max(1, Math.floor(Number(ttlSeconds) || DEFAULT_SHORT_LINK_TTL_SECONDS));
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  memoryMap.set(key, {
    value: serialized,
    expiresAtMs: Date.now() + safeTtl * 1000,
  });

  if (redisClient && typeof redisClient.set === 'function') {
    try {
      await redisClient.set(key, serialized, 'EX', safeTtl);
    } catch (err) {
      logger.warn('sep24_redis_set_failed', { key, message: err.message });
    }
  }
};

const getStoreValue = async (redisClient, memoryMap, key) => {
  if (redisClient && typeof redisClient.get === 'function') {
    try {
      const raw = await redisClient.get(key);
      if (raw != null) return JSON.parse(raw);
    } catch (err) {
      logger.warn('sep24_redis_get_failed', { key, message: err.message });
    }
  }

  const entry = memoryMap.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs <= Date.now()) {
    memoryMap.delete(key);
    return null;
  }
  return JSON.parse(entry.value);
};

const wrapAxiosError = (error, operation) => {
  if (error instanceof Sep24Error) return error;
  const status = error?.response?.status;
  const anchorError = error?.response?.data?.error || error?.response?.data?.message || null;
  if (status) {
    return new Sep24Error(
      anchorError || `SEP-24 ${operation} failed with status ${status}`,
      {
        statusCode: status,
        code: status === 401 || status === 403 ? 'sep24_unauthorized' : 'sep24_anchor_error',
        anchorError,
        details: error.response?.data || null,
      },
    );
  }
  return new Sep24Error(
    `SEP-24 ${operation} network error: ${error?.message || 'unknown error'}`,
    {
      statusCode: 502,
      code: 'sep24_network_error',
    },
  );
};

/**
 * Queries anchor SEP-24 capabilities (`GET /info`).
 */
const getInfo = async (params = {}, options = {}) => {
  const baseUrl = normalizeTransferServerUrl(params.transferServerUrl || params.serverUrl || options.transferServerUrl);
  const axiosImpl = options.axiosImpl || params.axiosImpl || axios;
  const timeoutMs = Number(options.timeoutMs || config?.requestLimits?.upstreamTimeoutMs || 10000);

  try {
    const response = await axiosImpl.get(`${baseUrl}/info`, {
      params: params.lang ? { lang: params.lang } : undefined,
      timeout: timeoutMs,
      headers: {
        Accept: 'application/json',
        ...outboundHeaders(),
      },
    });
    return response?.data || {};
  } catch (error) {
    throw wrapAxiosError(error, 'GET /info');
  }
};

const buildInteractiveRequestPayload = (params = {}) => {
  const assetCode = String(params.assetCode || params.asset_code || '').trim();
  if (!assetCode) {
    throw new Sep24Error('asset_code is required to initiate a SEP-24 interactive flow', {
      statusCode: 400,
      code: 'missing_asset_code',
    });
  }

  const payload = {
    asset_code: assetCode,
  };

  if (params.assetIssuer || params.asset_issuer) {
    payload.asset_issuer = String(params.assetIssuer || params.asset_issuer).trim();
  }
  if (params.account) payload.account = String(params.account).trim();
  if (params.amount !== undefined && params.amount !== null && String(params.amount).trim() !== '') {
    payload.amount = String(params.amount).trim();
  }
  if (params.memo) payload.memo = String(params.memo).trim();
  if (params.memoType || params.memo_type) {
    payload.memo_type = String(params.memoType || params.memo_type).trim();
  }
  if (params.walletName || params.wallet_name) {
    payload.wallet_name = String(params.walletName || params.wallet_name).trim();
  } else {
    payload.wallet_name = 'SendAm';
  }
  if (params.walletUrl || params.wallet_url) {
    payload.wallet_url = String(params.walletUrl || params.wallet_url).trim();
  }
  if (params.lang) payload.lang = String(params.lang).trim();
  if (params.callbackUrl || params.callback) {
    payload.callback = String(params.callbackUrl || params.callback).trim();
  }
  if (params.claimableBalanceSupported !== undefined || params.claimable_balance_supported !== undefined) {
    payload.claimable_balance_supported = String(
      Boolean(params.claimableBalanceSupported ?? params.claimable_balance_supported),
    );
  }
  if (params.customerId || params.customer_id) {
    payload.customer_id = String(params.customerId || params.customer_id).trim();
  }
  if (params.dest) payload.dest = String(params.dest).trim();
  if (params.destExtra || params.dest_extra) {
    payload.dest_extra = String(params.destExtra || params.dest_extra).trim();
  }

  if (params.extraFields && typeof params.extraFields === 'object') {
    for (const [k, v] of Object.entries(params.extraFields)) {
      if (v !== undefined && v !== null && payload[k] === undefined) {
        payload[k] = v;
      }
    }
  }

  return payload;
};

const validateInteractiveAnchorResponse = (data, operation) => {
  if (!data || typeof data !== 'object' || !data.url || !data.id) {
    throw new Sep24Error(`Invalid anchor response for SEP-24 ${operation}: missing interactive url or id`, {
      statusCode: 502,
      code: 'invalid_anchor_response',
      details: data,
    });
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(String(data.url));
  } catch (_err) {
    throw new Sep24Error(`Anchor returned a malformed interactive URL for ${operation}`, {
      statusCode: 502,
      code: 'invalid_interactive_url',
    });
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Sep24Error(`Anchor interactive URL has unsupported protocol: ${parsedUrl.protocol}`, {
      statusCode: 502,
      code: 'invalid_interactive_url',
    });
  }
  return {
    type: data.type || 'interactive_customer_info_needed',
    url: String(data.url),
    id: String(data.id),
  };
};

/**
 * Calls `POST /transactions/deposit/interactive` on the anchor SEP-24 server.
 */
const initiateDeposit = async (params = {}, options = {}) => {
  const baseUrl = normalizeTransferServerUrl(params.transferServerUrl || params.serverUrl || options.transferServerUrl);
  const bearerToken = normalizeJwt(params.jwt || params.token || options.jwt);
  const axiosImpl = options.axiosImpl || params.axiosImpl || axios;
  const timeoutMs = Number(options.timeoutMs || config?.requestLimits?.upstreamTimeoutMs || 10000);
  const payload = buildInteractiveRequestPayload(params);

  try {
    const response = await axiosImpl.post(`${baseUrl}/transactions/deposit/interactive`, payload, {
      timeout: timeoutMs,
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...outboundHeaders(),
      },
    });
    return validateInteractiveAnchorResponse(response?.data, 'deposit/interactive');
  } catch (error) {
    throw wrapAxiosError(error, 'POST /transactions/deposit/interactive');
  }
};

/**
 * Calls `POST /transactions/withdraw/interactive` on the anchor SEP-24 server.
 */
const initiateWithdrawal = async (params = {}, options = {}) => {
  const baseUrl = normalizeTransferServerUrl(params.transferServerUrl || params.serverUrl || options.transferServerUrl);
  const bearerToken = normalizeJwt(params.jwt || params.token || options.jwt);
  const axiosImpl = options.axiosImpl || params.axiosImpl || axios;
  const timeoutMs = Number(options.timeoutMs || config?.requestLimits?.upstreamTimeoutMs || 10000);
  const payload = buildInteractiveRequestPayload(params);

  try {
    const response = await axiosImpl.post(`${baseUrl}/transactions/withdraw/interactive`, payload, {
      timeout: timeoutMs,
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...outboundHeaders(),
      },
    });
    return validateInteractiveAnchorResponse(response?.data, 'withdraw/interactive');
  } catch (error) {
    throw wrapAxiosError(error, 'POST /transactions/withdraw/interactive');
  }
};

/**
 * Queries a single SEP-24 transaction from the anchor (`GET /transaction`).
 */
const getTransaction = async (params = {}, options = {}) => {
  const baseUrl = normalizeTransferServerUrl(params.transferServerUrl || params.serverUrl || options.transferServerUrl);
  const bearerToken = normalizeJwt(params.jwt || params.token || options.jwt);
  const axiosImpl = options.axiosImpl || params.axiosImpl || axios;
  const timeoutMs = Number(options.timeoutMs || config?.requestLimits?.upstreamTimeoutMs || 10000);

  const id = params.id;
  const stellarTxId = params.stellarTransactionId || params.stellar_transaction_id;
  const externalTxId = params.externalTransactionId || params.external_transaction_id;

  if (!id && !stellarTxId && !externalTxId) {
    throw new Sep24Error(
      'One of id, stellar_transaction_id, or external_transaction_id is required',
      { statusCode: 400, code: 'missing_transaction_identifier' },
    );
  }

  const query = {};
  if (id) query.id = String(id);
  if (stellarTxId) query.stellar_transaction_id = String(stellarTxId);
  if (externalTxId) query.external_transaction_id = String(externalTxId);
  if (params.lang) query.lang = String(params.lang);

  try {
    const response = await axiosImpl.get(`${baseUrl}/transaction`, {
      params: query,
      timeout: timeoutMs,
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: 'application/json',
        ...outboundHeaders(),
      },
    });
    return response?.data?.transaction || response?.data || null;
  } catch (error) {
    throw wrapAxiosError(error, 'GET /transaction');
  }
};

/**
 * Creates a short URL redirect session pointing to the anchor's interactive webview URL.
 */
const createShortLink = async (params = {}, options = {}) => {
  const {
    interactiveUrl,
    anchorTransactionId,
    transactionId = null,
    userId = null,
    phoneNumber = null,
    kind = 'deposit',
    assetCode = 'USDC',
    amount = null,
    ttlSeconds = DEFAULT_SHORT_LINK_TTL_SECONDS,
    publicBaseUrl,
  } = params;

  if (!interactiveUrl) {
    throw new Sep24Error('interactiveUrl is required to generate a short link', {
      statusCode: 400,
      code: 'missing_interactive_url',
    });
  }

  const redisClient = getRedisClient(options);
  const code = params.code || crypto.randomBytes(7).toString('base64url');
  const baseUrl = normalizePublicBaseUrl(publicBaseUrl || options.publicBaseUrl);
  const shortUrl = `${baseUrl}/api/sep24/r/${code}`;
  const expiresAt = new Date(Date.now() + Number(ttlSeconds) * 1000).toISOString();

  const sessionRecord = {
    code,
    shortUrl,
    interactiveUrl: String(interactiveUrl),
    anchorTransactionId: anchorTransactionId ? String(anchorTransactionId) : null,
    transactionId,
    userId,
    phoneNumber,
    kind,
    assetCode,
    amount: amount != null ? String(amount) : null,
    status: 'interactive_customer_info_needed',
    createdAt: new Date().toISOString(),
    expiresAt,
  };

  await setStoreValue(
    redisClient,
    memoryShortLinks,
    `${SHORT_LINK_KEY_PREFIX}${code}`,
    sessionRecord,
    ttlSeconds,
  );

  if (anchorTransactionId) {
    await setStoreValue(
      redisClient,
      memoryAnchorSessions,
      `${SESSION_BY_ANCHOR_TX_PREFIX}${anchorTransactionId}`,
      sessionRecord,
      ttlSeconds,
    );
  }

  return sessionRecord;
};

/**
 * Resolves a short URL code back to its interactive anchor webview session.
 */
const resolveShortLink = async (code, options = {}) => {
  if (!code || typeof code !== 'string') return null;
  const redisClient = getRedisClient(options);
  return getStoreValue(
    redisClient,
    memoryShortLinks,
    `${SHORT_LINK_KEY_PREFIX}${code.trim()}`,
  );
};

const formatWhatsAppInteractivePrompt = ({ kind, assetCode, amount, shortUrl }) => {
  const actionLabel = kind === 'withdraw' || kind === 'withdrawal' ? 'withdrawal' : 'deposit';
  const amountPrefix = amount ? `${amount} ${assetCode}` : assetCode;
  return `Complete your ${amountPrefix} ${actionLabel} securely in your browser: ${shortUrl}`;
};

/**
 * Initiates an interactive SEP-24 deposit or withdrawal session, persists a
 * pending transaction, generates a short redirect URL, and dispatches the link
 * to the user via WhatsApp.
 */
const startInteractiveFlow = async (params = {}, options = {}) => {
  const rawKind = String(params.kind || 'deposit').trim().toLowerCase();
  if (!['deposit', 'withdraw', 'withdrawal'].includes(rawKind)) {
    throw new Sep24Error(`Invalid SEP-24 flow kind: ${params.kind}`, {
      statusCode: 400,
      code: 'invalid_flow_kind',
    });
  }

  const normalizedKind = rawKind === ' withdrawal' || rawKind === 'withdrawal' || rawKind === 'withdraw'
    ? 'withdrawal'
    : 'deposit';

  const publicBaseUrl = normalizePublicBaseUrl(params.publicBaseUrl || options.publicBaseUrl);
  const callbackUrl = params.callbackUrl || `${publicBaseUrl}/api/sep24/callback`;

  const anchorRes = normalizedKind === 'deposit'
    ? await initiateDeposit({ ...params, callbackUrl }, options)
    : await initiateWithdrawal({ ...params, callbackUrl }, options);

  const assetCode = String(params.assetCode || params.asset_code || 'USDC').trim().toUpperCase();
  const amountStr = params.amount != null ? String(params.amount) : '0';
  const phoneNumber = params.phoneNumber || params.user?.phoneNumber || null;
  const userId = params.userId || params.user?.id || null;
  const prismaClient = options.prisma || params.prisma || getDefaultPrisma();

  let transactionRecord = null;
  if (userId && prismaClient?.transaction?.create) {
    transactionRecord = await prismaClient.transaction.create({
      data: {
        userId,
        type: normalizedKind,
        amount: amountStr,
        asset: assetCode,
        assetIssuer: params.assetIssuer || params.asset_issuer || null,
        rail: 'sep24',
        routeType: 'anchor_interactive',
        providerTransactionId: anchorRes.id,
        status: 'pending',
        recipientPhoneNumber: phoneNumber,
        metadata: {
          sep24: {
            kind: normalizedKind,
            anchorTransactionId: anchorRes.id,
            interactiveUrl: anchorRes.url,
            anchorStatus: 'incomplete',
          },
        },
      },
    });
  }

  const shortLink = await createShortLink({
    interactiveUrl: anchorRes.url,
    anchorTransactionId: anchorRes.id,
    transactionId: transactionRecord?.id || null,
    userId,
    phoneNumber,
    kind: normalizedKind,
    assetCode,
    amount: params.amount != null ? String(params.amount) : null,
    ttlSeconds: params.ttlSeconds || DEFAULT_SHORT_LINK_TTL_SECONDS,
    publicBaseUrl,
  }, options);

  let whatsappResult = null;
  const sendMessage = options.sendTextMessage || whatsappService.sendTextMessage;
  if (phoneNumber && typeof sendMessage === 'function') {
    const messageBody = formatWhatsAppInteractivePrompt({
      kind: normalizedKind,
      assetCode,
      amount: params.amount,
      shortUrl: shortLink.shortUrl,
    });
    whatsappResult = await sendMessage(phoneNumber, messageBody, {
      ...(options.whatsappOptions || {}),
      prisma: prismaClient,
    });
  }

  return {
    kind: normalizedKind,
    type: anchorRes.type,
    anchorTransactionId: anchorRes.id,
    transactionId: transactionRecord?.id || null,
    interactiveUrl: anchorRes.url,
    shortCode: shortLink.code,
    shortUrl: shortLink.shortUrl,
    expiresAt: shortLink.expiresAt,
    whatsappDelivery: whatsappResult,
  };
};

/**
 * Processes an anchor SEP-24 webhook callback updating transaction state and
 * notifying the customer on WhatsApp when a deposit or withdrawal progresses.
 */
const handleAnchorCallback = async (payload = {}, options = {}) => {
  const txPayload = (payload && typeof payload.transaction === 'object' && payload.transaction !== null)
    ? payload.transaction
    : payload;

  const anchorTransactionId = txPayload?.id ? String(txPayload.id).trim() : '';
  const anchorStatus = txPayload?.status ? String(txPayload.status).trim().toLowerCase() : '';

  if (!anchorTransactionId || !anchorStatus) {
    throw new Sep24Error('Malformed SEP-24 callback payload: transaction id and status are required', {
      statusCode: 400,
      code: 'malformed_callback',
    });
  }

  const internalStatus = SEP24_STATUS_TO_INTERNAL[anchorStatus] || 'processing';
  const redisClient = getRedisClient(options);
  const prismaClient = options.prisma || getDefaultPrisma();

  const cachedSession = await getStoreValue(
    redisClient,
    memoryAnchorSessions,
    `${SESSION_BY_ANCHOR_TX_PREFIX}${anchorTransactionId}`,
  );

  let dbTransaction = null;
  if (prismaClient?.transaction?.findFirst) {
    dbTransaction = await prismaClient.transaction.findFirst({
      where: { providerTransactionId: anchorTransactionId },
      include: { user: true },
    });
  }

  const stellarTxId = txPayload.stellar_transaction_id || txPayload.stellar_tx_id || null;
  const externalTxId = txPayload.external_transaction_id || null;
  const amountIn = txPayload.amount_in ? String(txPayload.amount_in) : null;
  const amountOut = txPayload.amount_out ? String(txPayload.amount_out) : null;
  const amountFee = txPayload.amount_fee ? String(txPayload.amount_fee) : null;
  const kind = txPayload.kind || cachedSession?.kind || dbTransaction?.type || 'deposit';

  if (dbTransaction && prismaClient?.transaction?.update) {
    const existingMeta = (dbTransaction.metadata && typeof dbTransaction.metadata === 'object')
      ? dbTransaction.metadata
      : {};
    const existingSep24 = (existingMeta.sep24 && typeof existingMeta.sep24 === 'object')
      ? existingMeta.sep24
      : {};

    dbTransaction = await prismaClient.transaction.update({
      where: { id: dbTransaction.id },
      data: {
        status: internalStatus,
        ...(stellarTxId ? { txHash: String(stellarTxId) } : {}),
        ...(amountIn && (!dbTransaction.amount || dbTransaction.amount === '0') ? { amount: amountIn } : {}),
        metadata: {
          ...existingMeta,
          sep24: {
            ...existingSep24,
            anchorTransactionId,
            anchorStatus,
            kind,
            amountIn,
            amountOut,
            amountFee,
            externalTransactionId: externalTxId,
            stellarTransactionId: stellarTxId,
            message: txPayload.message || null,
            updatedAt: new Date().toISOString(),
          },
        },
      },
    });
  }

  if (cachedSession) {
    const updatedSession = {
      ...cachedSession,
      status: anchorStatus,
      internalStatus,
      stellarTransactionId: stellarTxId,
      updatedAt: new Date().toISOString(),
    };
    await setStoreValue(
      redisClient,
      memoryAnchorSessions,
      `${SESSION_BY_ANCHOR_TX_PREFIX}${anchorTransactionId}`,
      updatedSession,
      DEFAULT_SHORT_LINK_TTL_SECONDS,
    );
    if (cachedSession.code) {
      await setStoreValue(
        redisClient,
        memoryShortLinks,
        `${SHORT_LINK_KEY_PREFIX}${cachedSession.code}`,
        updatedSession,
        DEFAULT_SHORT_LINK_TTL_SECONDS,
      );
    }
  }

  const phoneNumber = cachedSession?.phoneNumber
    || dbTransaction?.recipientPhoneNumber
    || dbTransaction?.user?.phoneNumber
    || txPayload.phone_number
    || null;

  let whatsappNotification = null;
  const sendMessage = options.sendTextMessage || whatsappService.sendTextMessage;
  if (phoneNumber && typeof sendMessage === 'function' && ['completed', 'error', 'refunded', 'expired'].includes(anchorStatus)) {
    const assetCode = cachedSession?.assetCode || dbTransaction?.asset || txPayload.asset_code || 'USDC';
    const displayAmount = amountOut || amountIn || cachedSession?.amount || dbTransaction?.amount || '';
    const amountLabel = displayAmount ? `${displayAmount} ${assetCode}` : assetCode;
    const actionLabel = String(kind).includes('withdraw') ? 'withdrawal' : 'deposit';

    const statusMessage = anchorStatus === 'completed'
      ? `Your ${amountLabel} ${actionLabel} has been completed (Ref: ${anchorTransactionId}).`
      : `Your ${amountLabel} ${actionLabel} status changed to ${anchorStatus}${txPayload.message ? `: ${txPayload.message}` : ''}.`;

    whatsappNotification = await sendMessage(phoneNumber, statusMessage, {
      ...(options.whatsappOptions || {}),
      prisma: prismaClient,
    });
  }

  return {
    anchorTransactionId,
    transactionId: dbTransaction?.id || cachedSession?.transactionId || null,
    anchorStatus,
    internalStatus,
    kind,
    stellarTransactionId: stellarTxId,
    notified: Boolean(whatsappNotification),
  };
};

const clearMemoryStores = () => {
  memoryShortLinks.clear();
  memoryAnchorSessions.clear();
};

module.exports = {
  SEP24_STATUS_TO_INTERNAL,
  Sep24Error,
  getInfo,
  initiateDeposit,
  initiateWithdrawal,
  getTransaction,
  createShortLink,
  resolveShortLink,
  startInteractiveFlow,
  handleAnchorCallback,
  formatWhatsAppInteractivePrompt,
  clearMemoryStores,
};
