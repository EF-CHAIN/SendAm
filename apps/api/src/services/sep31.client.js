'use strict';

const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');
const { increment } = require('../observability/metrics');
const { outboundHeaders } = require('../observability/context');

const SEP31_ACTIVE_STATUSES = Object.freeze([
  'pending_sender',
  'pending_stellar',
  'pending_customer_info_update',
  'pending_transaction_info_update',
  'pending_receiver',
  'pending_external',
]);

const SEP31_TERMINAL_STATUSES = Object.freeze([
  'completed',
  'refunded',
  'expired',
  'error',
]);

const SEP31_STATUS_TO_INTERNAL = Object.freeze({
  pending_sender: 'pending',
  pending_stellar: 'processing',
  pending_customer_info_update: 'escalated',
  pending_transaction_info_update: 'escalated',
  pending_receiver: 'processing',
  pending_external: 'processing',
  completed: 'success',
  refunded: 'reversed',
  expired: 'expired',
  error: 'failed',
});

const VALID_DECIMAL_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getStellarAdapter = () => require('../wallet/stellar.adapter');
const getWalletService = () => require('../wallet/wallet.service');
const getDefaultPrisma = () => {
  try {
    return require('../common/prisma');
  } catch (_err) {
    return null;
  }
};
const getDefaultAuditLogger = () => {
  try {
    return require('../common/audit.service').writeAuditLog;
  } catch (_err) {
    return null;
  }
};

class Sep31Error extends Error {
  constructor(
    message,
    {
      statusCode = 502,
      code = 'sep31_error',
      anchorError = null,
      fields = null,
      customerType = null,
      details = null,
    } = {},
  ) {
    super(message);
    this.name = 'Sep31Error';
    this.statusCode = statusCode;
    this.code = code;
    this.anchorError = anchorError;
    this.fields = fields;
    this.customerType = customerType;
    this.details = details;
  }
}

const normalizeDirectPaymentServerUrl = (url) => {
  const raw = String(url || config?.stellar?.sep31Url || '').trim();
  if (!raw) {
    throw new Sep31Error('SEP-31 direct payment server URL is required', {
      statusCode: 400,
      code: 'missing_direct_payment_server_url',
    });
  }
  return raw.replace(/\/+$/, '');
};

const normalizeJwt = (jwt) => {
  const token = String(jwt || '').trim().replace(/^Bearer\s+/i, '');
  if (!token) {
    throw new Sep31Error('SEP-10 JWT bearer token is required for SEP-31 requests', {
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

const normalizePositiveDecimal = (amount, fieldName = 'amount') => {
  const raw = String(amount ?? '').trim();
  if (!VALID_DECIMAL_RE.test(raw) || !/[1-9]/.test(raw)) {
    throw new Sep31Error(`${fieldName} must be a positive decimal string`, {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }
  return raw;
};

const normalizeSep31Memo = ({ memo, memoType = 'text' } = {}) => {
  if (memo === undefined || memo === null || memo === '') {
    return { memo: null, rawMemo: null, memoType: null };
  }

  const type = String(memoType || 'text').trim().toLowerCase();
  if (!['text', 'id', 'hash', 'return'].includes(type)) {
    throw new Sep31Error(`Unsupported SEP-31 stellar_memo_type: ${memoType}`, {
      statusCode: 502,
      code: 'invalid_anchor_response',
    });
  }

  let normalizedMemo = memo;
  if (type === 'hash' || type === 'return') {
    if (Buffer.isBuffer(memo)) {
      normalizedMemo = memo.toString('hex');
    } else if (typeof memo === 'string') {
      const trimmed = memo.trim();
      if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        normalizedMemo = trimmed.toLowerCase();
      } else {
        const decoded = Buffer.from(trimmed, 'base64');
        if (decoded.length !== 32 || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
          throw new Sep31Error(`Invalid SEP-31 ${type} memo from anchor`, {
            statusCode: 502,
            code: 'invalid_anchor_response',
          });
        }
        normalizedMemo = decoded.toString('hex');
      }
    }
  } else {
    normalizedMemo = String(memo).trim();
  }

  try {
    getStellarAdapter().validateMemo({ memo: normalizedMemo, memoType: type });
  } catch (err) {
    throw new Sep31Error(`Invalid SEP-31 anchor memo: ${err.message}`, {
      statusCode: 502,
      code: 'invalid_anchor_response',
    });
  }

  return {
    memo: normalizedMemo,
    rawMemo: Buffer.isBuffer(memo) ? memo.toString('hex') : String(memo),
    memoType: type,
  };
};

const wrapAxiosError = (error, operation) => {
  if (error instanceof Sep31Error) return error;

  const status = error?.response?.status;
  const data = error?.response?.data;
  const anchorError = data?.error || data?.message || null;

  if (status === 400 && data?.error === 'transaction_info_needed') {
    return new Sep31Error('Anchor requires additional SEP-31 transaction fields', {
      statusCode: 400,
      code: 'transaction_info_needed',
      anchorError,
      fields: data?.fields || null,
      details: data,
    });
  }

  if (status === 400 && data?.error === 'customer_info_needed') {
    return new Sep31Error('Anchor requires SEP-12 customer info update', {
      statusCode: 400,
      code: 'customer_info_needed',
      anchorError,
      customerType: data?.type || null,
      details: data,
    });
  }

  if (status === 401 || status === 403) {
    return new Sep31Error(anchorError || `SEP-31 ${operation} unauthorized`, {
      statusCode: status,
      code: 'sep31_unauthorized',
      anchorError,
      details: data || null,
    });
  }

  if (status === 404) {
    return new Sep31Error(anchorError || 'SEP-31 transaction not found', {
      statusCode: 404,
      code: 'sep31_transaction_not_found',
      anchorError,
      details: data || null,
    });
  }

  if (status) {
    return new Sep31Error(anchorError || `SEP-31 ${operation} failed with status ${status}`, {
      statusCode: status,
      code: 'sep31_anchor_error',
      anchorError,
      details: data || null,
    });
  }

  return new Sep31Error(`SEP-31 ${operation} network error: ${error?.message || 'unknown error'}`, {
    statusCode: 502,
    code: 'sep31_network_error',
  });
};

const normalizeSep31Transaction = (raw) => {
  const tx = raw?.transaction && typeof raw.transaction === 'object' ? raw.transaction : raw;
  const status = tx?.status ? String(tx.status).trim().toLowerCase() : null;
  const hasMemo = tx?.stellar_memo !== undefined && tx?.stellar_memo !== null && tx?.stellar_memo !== '';
  const memo = hasMemo
    ? normalizeSep31Memo({ memo: tx.stellar_memo, memoType: tx.stellar_memo_type || 'text' })
    : { memo: null, rawMemo: null, memoType: null };

  return {
    id: tx?.id || null,
    status,
    internalStatus: status ? (SEP31_STATUS_TO_INTERNAL[status] || 'processing') : null,
    isTerminal: status ? SEP31_TERMINAL_STATUSES.includes(status) : false,
    statusEta: tx?.status_eta ?? null,
    amountIn: tx?.amount_in ?? null,
    amountInAsset: tx?.amount_in_asset || null,
    amountOut: tx?.amount_out ?? null,
    amountOutAsset: tx?.amount_out_asset || null,
    amountFee: tx?.amount_fee ?? null,
    amountFeeAsset: tx?.amount_fee_asset || null,
    stellarAccountId: tx?.stellar_account_id || null,
    stellarMemo: memo.memo,
    rawStellarMemo: memo.rawMemo,
    stellarMemoType: memo.memoType,
    stellarTransactionId: tx?.stellar_transaction_id || null,
    externalTransactionId: tx?.external_transaction_id || null,
    requiredInfoMessage: tx?.required_info_message || null,
    requiredInfoUpdates: tx?.required_info_updates || null,
    refunds: tx?.refunds || null,
    startedAt: tx?.started_at || null,
    completedAt: tx?.completed_at || null,
    updatedAt: tx?.updated_at || null,
    raw: tx,
  };
};

const getInfo = async ({ directPaymentServerUrl, lang, jwt } = {}, options = {}) => {
  const baseUrl = normalizeDirectPaymentServerUrl(directPaymentServerUrl);
  const axiosImpl = options.axiosImpl || axios;
  const timeout = Number(options.timeoutMs ?? config?.requestLimits?.upstreamTimeoutMs ?? 10000);
  const token = normalizeOptionalJwt(jwt);

  try {
    const response = await axiosImpl.get(`${baseUrl}/info`, {
      params: lang ? { lang } : {},
      headers: {
        ...outboundHeaders(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeout,
    });
    increment('sendam_sep31_requests_total', { operation: 'info', result: 'success' });
    return response.data || {};
  } catch (error) {
    const wrapped = wrapAxiosError(error, 'info');
    increment('sendam_sep31_requests_total', { operation: 'info', result: wrapped.code });
    throw wrapped;
  }
};

const validateReceiveCorridor = (info, { assetCode, amount, quoteId, fields } = {}) => {
  const code = String(assetCode || '').trim();
  const assetConfig = info?.receive?.[code];
  if (!assetConfig || assetConfig.enabled === false) {
    throw new Sep31Error(`Receiving anchor does not support SEP-31 receive for asset ${code}`, {
      statusCode: 400,
      code: 'unsupported_receive_asset',
    });
  }

  if (amount !== undefined && amount !== null) {
    const numericAmount = Number(amount);
    if (assetConfig.min_amount != null && numericAmount < Number(assetConfig.min_amount)) {
      throw new Sep31Error(
        `Amount ${amount} ${code} is below anchor minimum ${assetConfig.min_amount}`,
        { statusCode: 400, code: 'amount_below_minimum' },
      );
    }
    if (assetConfig.max_amount != null && numericAmount > Number(assetConfig.max_amount)) {
      throw new Sep31Error(
        `Amount ${amount} ${code} exceeds anchor maximum ${assetConfig.max_amount}`,
        { statusCode: 400, code: 'amount_above_maximum' },
      );
    }
  }

  if (assetConfig.quotes_required && !quoteId) {
    throw new Sep31Error(`Anchor requires a SEP-38 quoteId for ${code} SEP-31 transactions`, {
      statusCode: 400,
      code: 'quote_required',
    });
  }

  const requiredTxFields = assetConfig.fields?.transaction;
  if (requiredTxFields && typeof requiredTxFields === 'object') {
    const providedTxFields = fields?.transaction || {};
    const missing = [];
    for (const [key, spec] of Object.entries(requiredTxFields)) {
      const isOptional = spec && spec.optional === true;
      if (!isOptional && (providedTxFields[key] === undefined || providedTxFields[key] === null || providedTxFields[key] === '')) {
        missing.push(key);
      }
    }
    if (missing.length > 0) {
      throw new Sep31Error(`Missing required SEP-31 transaction fields: ${missing.join(', ')}`, {
        statusCode: 400,
        code: 'transaction_info_needed',
        fields: { transaction: Object.fromEntries(missing.map((k) => [k, requiredTxFields[k]])) },
      });
    }
  }

  return assetConfig;
};

const createTransaction = async (
  {
    directPaymentServerUrl,
    jwt,
    amount,
    assetCode,
    assetIssuer,
    destinationAsset,
    quoteId,
    senderId,
    receiverId,
    fields,
    lang,
    fundingMethod,
  } = {},
  options = {},
) => {
  const baseUrl = normalizeDirectPaymentServerUrl(directPaymentServerUrl);
  const token = normalizeJwt(jwt);
  const code = String(assetCode || '').trim();
  if (!code) {
    throw new Sep31Error('assetCode is required for SEP-31 transaction creation', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }
  const normalizedAmount = normalizePositiveDecimal(amount, 'amount');

  const body = {
    amount: normalizedAmount,
    asset_code: code,
    ...(assetIssuer ? { asset_issuer: String(assetIssuer).trim() } : {}),
    ...(destinationAsset ? { destination_asset: String(destinationAsset).trim() } : {}),
    ...(quoteId ? { quote_id: String(quoteId).trim() } : {}),
    ...(senderId ? { sender_id: String(senderId).trim() } : {}),
    ...(receiverId ? { receiver_id: String(receiverId).trim() } : {}),
    ...(fields ? { fields } : {}),
    ...(lang ? { lang } : {}),
    ...(fundingMethod ? { funding_method: fundingMethod } : {}),
  };

  const axiosImpl = options.axiosImpl || axios;
  const timeout = Number(options.timeoutMs ?? config?.requestLimits?.upstreamTimeoutMs ?? 10000);

  let data;
  try {
    const response = await axiosImpl.post(`${baseUrl}/transactions`, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...outboundHeaders(),
      },
      timeout,
    });
    data = response.data || {};
    increment('sendam_sep31_requests_total', { operation: 'create_transaction', result: 'success' });
  } catch (error) {
    const wrapped = wrapAxiosError(error, 'create_transaction');
    increment('sendam_sep31_requests_total', { operation: 'create_transaction', result: wrapped.code });
    throw wrapped;
  }

  const stellarAdapter = getStellarAdapter();
  const id = String(data.id || '').trim();
  const stellarAccountId = String(data.stellar_account_id || '').trim();
  if (!id || !stellarAdapter.validateAddress(stellarAccountId)) {
    throw new Sep31Error('SEP-31 anchor response missing valid id or stellar_account_id', {
      statusCode: 502,
      code: 'invalid_anchor_response',
      details: data,
    });
  }

  const hasMemo = data.stellar_memo !== undefined && data.stellar_memo !== null && data.stellar_memo !== '';
  if (stellarAdapter.isMuxedAddress?.(stellarAccountId) && hasMemo) {
    throw new Sep31Error('SEP-31 anchor returned conflicting muxed stellar_account_id and stellar_memo', {
      statusCode: 502,
      code: 'invalid_anchor_response',
      details: data,
    });
  }

  const parsedMemo = hasMemo
    ? normalizeSep31Memo({ memo: data.stellar_memo, memoType: data.stellar_memo_type || 'text' })
    : { memo: null, rawMemo: null, memoType: null };

  return {
    id,
    stellarAccountId,
    stellarMemo: parsedMemo.memo,
    rawStellarMemo: parsedMemo.rawMemo,
    stellarMemoType: parsedMemo.memoType,
    raw: data,
  };
};

const getTransaction = async ({ directPaymentServerUrl, jwt, id, lang } = {}, options = {}) => {
  const baseUrl = normalizeDirectPaymentServerUrl(directPaymentServerUrl);
  const token = normalizeJwt(jwt);
  const txId = String(id || '').trim();
  if (!txId) {
    throw new Sep31Error('SEP-31 transaction id is required', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }

  const axiosImpl = options.axiosImpl || axios;
  const timeout = Number(options.timeoutMs ?? config?.requestLimits?.upstreamTimeoutMs ?? 10000);

  try {
    const response = await axiosImpl.get(`${baseUrl}/transactions/${encodeURIComponent(txId)}`, {
      params: lang ? { lang } : {},
      headers: {
        Authorization: `Bearer ${token}`,
        ...outboundHeaders(),
      },
      timeout,
    });
    increment('sendam_sep31_requests_total', { operation: 'get_transaction', result: 'success' });
    return normalizeSep31Transaction(response.data);
  } catch (error) {
    const wrapped = wrapAxiosError(error, 'get_transaction');
    increment('sendam_sep31_requests_total', { operation: 'get_transaction', result: wrapped.code });
    throw wrapped;
  }
};

const updateTransaction = async ({ directPaymentServerUrl, jwt, id, fields } = {}, options = {}) => {
  const baseUrl = normalizeDirectPaymentServerUrl(directPaymentServerUrl);
  const token = normalizeJwt(jwt);
  const txId = String(id || '').trim();
  if (!txId) {
    throw new Sep31Error('SEP-31 transaction id is required', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }
  if (!fields || typeof fields !== 'object') {
    throw new Sep31Error('fields object is required to update SEP-31 transaction', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }

  const axiosImpl = options.axiosImpl || axios;
  const timeout = Number(options.timeoutMs ?? config?.requestLimits?.upstreamTimeoutMs ?? 10000);

  try {
    const response = await axiosImpl.patch(
      `${baseUrl}/transactions/${encodeURIComponent(txId)}`,
      { fields },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...outboundHeaders(),
        },
        timeout,
      },
    );
    increment('sendam_sep31_requests_total', { operation: 'update_transaction', result: 'success' });
    return response.data || { updated: true };
  } catch (error) {
    const wrapped = wrapAxiosError(error, 'update_transaction');
    increment('sendam_sep31_requests_total', { operation: 'update_transaction', result: wrapped.code });
    throw wrapped;
  }
};

const registerCallback = async ({ directPaymentServerUrl, jwt, id, callbackUrl } = {}, options = {}) => {
  const baseUrl = normalizeDirectPaymentServerUrl(directPaymentServerUrl);
  const token = normalizeJwt(jwt);
  const txId = String(id || '').trim();
  const url = String(callbackUrl || '').trim();
  if (!txId) {
    throw new Sep31Error('SEP-31 transaction id is required', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }
  if (!/^https?:\/\/.+/i.test(url)) {
    throw new Sep31Error('callbackUrl must be a valid HTTP(S) URL', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }

  const axiosImpl = options.axiosImpl || axios;
  const timeout = Number(options.timeoutMs ?? config?.requestLimits?.upstreamTimeoutMs ?? 10000);

  try {
    const response = await axiosImpl.put(
      `${baseUrl}/transactions/${encodeURIComponent(txId)}/callback`,
      { url },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...outboundHeaders(),
        },
        timeout,
      },
    );
    increment('sendam_sep31_requests_total', { operation: 'register_callback', result: 'success' });
    return response.data || { registered: true, url };
  } catch (error) {
    const wrapped = wrapAxiosError(error, 'register_callback');
    increment('sendam_sep31_requests_total', { operation: 'register_callback', result: wrapped.code });
    throw wrapped;
  }
};

const submitAnchorPayment = async (
  { stellarAccountId, amount, assetCode = 'USDC', memo = null, memoType = null, wallet = null, secretKey = null } = {},
  options = {},
) => {
  const stellarAdapter = getStellarAdapter();
  const destination = String(stellarAccountId || '').trim();
  if (!stellarAdapter.validateAddress(destination)) {
    throw new Sep31Error('stellarAccountId must be a valid Stellar address', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }

  const normalizedAmount = normalizePositiveDecimal(amount, 'amount');
  if (memo !== undefined && memo !== null && memo !== '') {
    stellarAdapter.validateMemo({ memo, memoType: memoType || 'text' });
  }

  const paymentArgs = {
    destination,
    amount: normalizedAmount,
    asset: assetCode,
    memo,
    memoType,
  };

  if (typeof options.submitPayment === 'function') {
    return options.submitPayment({ wallet, secretKey, ...paymentArgs });
  }
  if (wallet) {
    return getWalletService().submitPayment({ wallet, ...paymentArgs });
  }
  if (secretKey) {
    return stellarAdapter.submitPayment({ secretKey, ...paymentArgs });
  }

  throw new Sep31Error('wallet, secretKey, or submitPayment handler is required to submit Stellar payment', {
    statusCode: 400,
    code: 'missing_signing_credentials',
  });
};

const pollTransactionUntilSettled = async (
  {
    directPaymentServerUrl,
    jwt,
    id,
    pollIntervalMs = 1000,
    maxAttempts = 20,
    stopOnInfoUpdate = true,
    sleepImpl = sleep,
  } = {},
  options = {},
) => {
  const statusHistory = [];
  const attempts = Math.max(1, Number(maxAttempts || 1));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const tx = await getTransaction({ directPaymentServerUrl, jwt, id }, options);
    if (statusHistory.length === 0 || statusHistory[statusHistory.length - 1] !== tx.status) {
      statusHistory.push(tx.status);
    }

    if (tx.isTerminal) {
      return { transaction: tx, statusHistory, attempts: attempt };
    }
    if (
      stopOnInfoUpdate
      && ['pending_customer_info_update', 'pending_transaction_info_update'].includes(tx.status)
    ) {
      return { transaction: tx, statusHistory, attempts: attempt };
    }

    if (attempt < attempts && pollIntervalMs > 0) {
      await sleepImpl(pollIntervalMs);
    }
  }

  throw new Sep31Error(`SEP-31 transaction ${id} did not settle within ${attempts} poll attempts`, {
    statusCode: 504,
    code: 'sep31_poll_timeout',
    details: { id, statusHistory },
  });
};

const executeCrossBorderPayment = async (
  {
    directPaymentServerUrl,
    jwt,
    amount,
    assetCode,
    assetIssuer,
    destinationAsset,
    quoteId,
    senderId,
    receiverId,
    fields,
    lang,
    fundingMethod,
    callbackUrl,
    wallet,
    secretKey,
    userId,
    recipientPhoneNumber,
    idempotencyKey,
    verifyInfo = true,
    waitForCompletion = false,
    pollIntervalMs = 1000,
    maxPollAttempts = 20,
  } = {},
  options = {},
) => {
  const normalizedAmount = normalizePositiveDecimal(amount, 'amount');

  if (verifyInfo) {
    const info = await getInfo({ directPaymentServerUrl, lang, jwt }, options);
    validateReceiveCorridor(info, { assetCode, amount: normalizedAmount, quoteId, fields });
  }

  const anchorTransaction = await createTransaction(
    {
      directPaymentServerUrl,
      jwt,
      amount: normalizedAmount,
      assetCode,
      assetIssuer,
      destinationAsset,
      quoteId,
      senderId,
      receiverId,
      fields,
      lang,
      fundingMethod,
    },
    options,
  );

  if (callbackUrl) {
    await registerCallback(
      {
        directPaymentServerUrl,
        jwt,
        id: anchorTransaction.id,
        callbackUrl,
      },
      options,
    );
  }

  const payment = await submitAnchorPayment(
    {
      stellarAccountId: anchorTransaction.stellarAccountId,
      amount: normalizedAmount,
      assetCode,
      memo: anchorTransaction.stellarMemo,
      memoType: anchorTransaction.stellarMemoType,
      wallet,
      secretKey,
    },
    options,
  );

  const prismaClient = options.prisma !== undefined
    ? options.prisma
    : (userId ? getDefaultPrisma() : null);

  let transaction = null;
  const sep31Meta = {
    anchorTransactionId: anchorTransaction.id,
    directPaymentServerUrl: normalizeDirectPaymentServerUrl(directPaymentServerUrl),
    senderId: senderId || null,
    receiverId: receiverId || null,
    destinationAsset: destinationAsset || null,
    quoteId: quoteId || null,
    stellarAccountId: anchorTransaction.stellarAccountId,
    memo: anchorTransaction.stellarMemo,
    memoType: anchorTransaction.stellarMemoType,
    anchorStatus: 'pending_sender',
  };

  if (userId && prismaClient?.transaction?.create) {
    transaction = await prismaClient.transaction.create({
      data: {
        userId,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        type: 'send',
        amount: normalizedAmount,
        asset: String(assetCode).trim(),
        ...(assetIssuer ? { assetIssuer: String(assetIssuer).trim() } : {}),
        ...(quoteId ? { quoteId: String(quoteId).trim() } : {}),
        destination: anchorTransaction.stellarAccountId,
        recipientPhoneNumber: recipientPhoneNumber || null,
        rail: 'sep31',
        routeType: 'cross_border',
        txHash: payment?.txHash || null,
        providerTransactionId: anchorTransaction.id,
        explorerUrl: payment?.explorerUrl || null,
        status: 'pending',
        metadata: {
          sep31: sep31Meta,
        },
      },
    });
  }

  let finalStatus = null;
  let statusHistory = [];
  if (waitForCompletion) {
    const pollResult = await pollTransactionUntilSettled(
      {
        directPaymentServerUrl,
        jwt,
        id: anchorTransaction.id,
        pollIntervalMs,
        maxAttempts: maxPollAttempts,
        sleepImpl: options.sleepImpl,
      },
      options,
    );
    finalStatus = pollResult.transaction;
    statusHistory = pollResult.statusHistory;

    if (transaction && prismaClient?.transaction?.update) {
      transaction = await prismaClient.transaction.update({
        where: { id: transaction.id },
        data: {
          status: finalStatus.internalStatus || transaction.status,
          metadata: {
            ...(transaction.metadata || {}),
            sep31: {
              ...sep31Meta,
              anchorStatus: finalStatus.status,
              externalTransactionId: finalStatus.externalTransactionId,
              amountOut: finalStatus.amountOut,
              completedAt: finalStatus.completedAt,
              statusHistory,
            },
          },
        },
      });
    }
  }

  const writeAuditLog = options.writeAuditLog || getDefaultAuditLogger();
  if (typeof writeAuditLog === 'function') {
    await writeAuditLog({
      actorType: userId ? 'user' : 'system',
      actorId: String(userId || 'sep31'),
      action: 'sep31.payment.executed',
      entityType: 'Transaction',
      entityId: String(transaction?.id || anchorTransaction.id),
      metadata: {
        anchorTransactionId: anchorTransaction.id,
        assetCode,
        amount: normalizedAmount,
        destinationAsset: destinationAsset || null,
        txHash: payment?.txHash || null,
        finalAnchorStatus: finalStatus?.status || 'pending_sender',
      },
    }).catch((err) => logger.warn('sep31_audit_log_failed', { message: err.message }));
  }

  return {
    anchorTransaction,
    payment,
    finalStatus,
    statusHistory,
    transaction,
  };
};

module.exports = {
  SEP31_ACTIVE_STATUSES,
  SEP31_TERMINAL_STATUSES,
  SEP31_STATUS_TO_INTERNAL,
  Sep31Error,
  normalizeDirectPaymentServerUrl,
  normalizeSep31Memo,
  validateReceiveCorridor,
  getInfo,
  createTransaction,
  getTransaction,
  updateTransaction,
  registerCallback,
  submitAnchorPayment,
  pollTransactionUntilSettled,
  executeCrossBorderPayment,
};
