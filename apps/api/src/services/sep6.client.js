'use strict';

const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');
const { canonicalizePhoneNumber } = require('../utils/validators');
const { increment } = require('../observability/metrics');
const { outboundHeaders } = require('../observability/context');

const MOBILE_MONEY_RAIL_ALIASES = Object.freeze({
  mpesa: 'mpesa',
  'm-pesa': 'mpesa',
  mtn_mobile_money: 'mtn_mobile_money',
  'mtn-mobile-money': 'mtn_mobile_money',
  mtn: 'mtn_mobile_money',
  airtel_money: 'airtel_money',
  'airtel-money': 'airtel_money',
  airtel: 'airtel_money',
  orange_money: 'orange_money',
  'orange-money': 'orange_money',
  orange: 'orange_money',
  mobile_money: 'mobile_money',
  mobile: 'mobile_money',
});

const MOBILE_MONEY_RAILS = Object.freeze(
  new Set(['mpesa', 'mtn_mobile_money', 'airtel_money', 'orange_money', 'mobile_money']),
);

const BANK_WITHDRAWAL_RAILS = Object.freeze(
  new Set(['bank_account', 'bank_transfer', 'nibss', 'ach', 'sepa', 'wire']),
);

const VALID_DECIMAL_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

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

class Sep6Error extends Error {
  constructor(
    message,
    {
      statusCode = 502,
      code = 'sep6_error',
      type = null,
      anchorError = null,
      fields = null,
      kycStatus = null,
      moreInfoUrl = null,
      eta = null,
      details = null,
    } = {},
  ) {
    super(message);
    this.name = 'Sep6Error';
    this.statusCode = statusCode;
    this.code = code;
    this.type = type;
    this.anchorError = anchorError;
    this.fields = fields;
    this.kycStatus = kycStatus;
    this.moreInfoUrl = moreInfoUrl;
    this.eta = eta;
    this.details = details;
  }
}

const normalizeTransferServerUrl = (url) => {
  const raw = String(url || config?.stellar?.sep6Url || '').trim();
  if (!raw) {
    throw new Sep6Error('SEP-6 transfer server URL is required', {
      statusCode: 400,
      code: 'missing_transfer_server_url',
    });
  }
  return raw.replace(/\/+$/, '');
};

const normalizeOptionalJwt = (jwt) => {
  if (!jwt) return null;
  const token = String(jwt).trim().replace(/^Bearer\s+/i, '');
  return token || null;
};

const normalizePositiveDecimal = (amount, fieldName = 'amount') => {
  const raw = String(amount ?? '').trim();
  if (!VALID_DECIMAL_RE.test(raw) || !/[1-9]/.test(raw)) {
    throw new Sep6Error(`${fieldName} must be a positive decimal string`, {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }
  return raw;
};

const normalizeMobileMoneyRail = (rail) => {
  const key = String(rail || 'mobile_money').trim().toLowerCase().replace(/\s+/g, '_');
  const resolved = MOBILE_MONEY_RAIL_ALIASES[key];
  if (!resolved || !MOBILE_MONEY_RAILS.has(resolved)) {
    throw new Sep6Error(
      `Unsupported mobile money rail: ${rail}. Supported: ${Array.from(MOBILE_MONEY_RAILS).join(', ')}`,
      {
        statusCode: 400,
        code: 'unsupported_mobile_money_rail',
      },
    );
  }
  return resolved;
};

const normalizeSep6Memo = ({ memo, memoType = 'text' } = {}) => {
  if (memo === undefined || memo === null || memo === '') {
    return { memo: null, rawMemo: null, memoType: null };
  }

  const type = String(memoType || 'text').trim().toLowerCase();
  if (!['text', 'id', 'hash', 'return'].includes(type)) {
    throw new Sep6Error(`Unsupported SEP-6 memo_type: ${memoType}`, {
      statusCode: 400,
      code: 'invalid_memo',
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
          throw new Sep6Error(`Invalid ${type} memo: must be 32-byte hex or base64`, {
            statusCode: 400,
            code: 'invalid_memo',
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
    throw new Sep6Error(err.message, {
      statusCode: 400,
      code: 'invalid_memo',
    });
  }

  return {
    memo: normalizedMemo,
    rawMemo: Buffer.isBuffer(memo) ? memo.toString('hex') : String(memo),
    memoType: type,
  };
};

const wrapAxiosError = (error, operation) => {
  if (error instanceof Sep6Error) return error;

  const status = error?.response?.status;
  const data = error?.response?.data;
  const type = data?.type || null;
  const anchorError = data?.error || data?.message || null;

  if (status === 403 && type === 'non_interactive_customer_info_needed') {
    return new Sep6Error(
      anchorError || 'Anchor requires SEP-12 customer KYC fields before processing',
      {
        statusCode: 403,
        code: 'kyc_info_needed',
        type,
        fields: data?.fields || [],
        anchorError,
        details: data,
      },
    );
  }

  if (status === 403 && type === 'customer_info_status') {
    return new Sep6Error(
      anchorError || `Customer KYC status is ${data?.status || 'pending'}`,
      {
        statusCode: 403,
        code: 'kyc_status',
        type,
        kycStatus: data?.status || null,
        moreInfoUrl: data?.more_info_url || null,
        eta: data?.eta ?? null,
        anchorError,
        details: data,
      },
    );
  }

  if (type === 'authentication_required' || status === 401 || status === 403) {
    return new Sep6Error(
      anchorError || `SEP-6 ${operation} requires SEP-10 authentication`,
      {
        statusCode: status || 401,
        code: 'sep6_unauthorized',
        type,
        anchorError,
        details: data || null,
      },
    );
  }

  if (status) {
    return new Sep6Error(
      anchorError || `SEP-6 ${operation} failed with status ${status}`,
      {
        statusCode: status,
        code: 'sep6_anchor_error',
        type,
        anchorError,
        details: data || null,
      },
    );
  }

  return new Sep6Error(
    `SEP-6 ${operation} network error: ${error?.message || 'unknown error'}`,
    {
      statusCode: 502,
      code: 'sep6_network_error',
    },
  );
};

const performGet = async ({ url, params, jwt, operation, options = {} }) => {
  const axiosImpl = options.axiosImpl || axios;
  const timeout = Number(options.timeoutMs ?? config?.requestLimits?.upstreamTimeoutMs ?? 10000);
  const token = normalizeOptionalJwt(jwt);
  const headers = {
    ...outboundHeaders(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  try {
    const response = await axiosImpl.get(url, { params, headers, timeout });
    increment('sendam_sep6_requests_total', { operation, result: 'success' });
    return response.data || {};
  } catch (error) {
    const wrapped = wrapAxiosError(error, operation);
    increment('sendam_sep6_requests_total', { operation, result: wrapped.code });
    throw wrapped;
  }
};

const getInfo = async ({ transferServerUrl, lang, jwt } = {}, options = {}) => {
  const baseUrl = normalizeTransferServerUrl(transferServerUrl);
  const params = {};
  if (lang) params.lang = lang;
  return performGet({
    url: `${baseUrl}/info`,
    params,
    jwt,
    operation: 'info',
    options,
  });
};

const getFee = async ({ transferServerUrl, operation, type, assetCode, amount, jwt } = {}, options = {}) => {
  const baseUrl = normalizeTransferServerUrl(transferServerUrl);
  const op = String(operation || '').trim().toLowerCase();
  if (!['deposit', 'withdraw'].includes(op)) {
    throw new Sep6Error('operation must be either deposit or withdraw', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }
  const code = String(assetCode || '').trim();
  if (!code) {
    throw new Sep6Error('assetCode is required', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }
  const normalizedAmount = normalizePositiveDecimal(amount, 'amount');

  const params = {
    operation: op,
    asset_code: code,
    amount: normalizedAmount,
    ...(type ? { type: String(type).trim() } : {}),
  };

  return performGet({
    url: `${baseUrl}/fee`,
    params,
    jwt,
    operation: 'fee',
    options,
  });
};

const requestDeposit = async (
  {
    transferServerUrl,
    assetCode,
    account,
    amount,
    type,
    memo,
    memoType,
    emailAddress,
    walletName,
    walletUrl,
    lang,
    onChangeCallback,
    countryCode,
    claimableBalanceSupported,
    customerId,
    locationId,
    extraFields,
    jwt,
  } = {},
  options = {},
) => {
  const baseUrl = normalizeTransferServerUrl(transferServerUrl);
  const code = String(assetCode || '').trim();
  if (!code) {
    throw new Sep6Error('assetCode is required for SEP-6 deposit', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }

  const stellarAdapter = getStellarAdapter();
  const resolvedAccount = String(account || '').trim();
  if (!stellarAdapter.validateAddress(resolvedAccount)) {
    throw new Sep6Error('account must be a valid Stellar address for SEP-6 deposit', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }

  const normalizedAmount = amount !== undefined && amount !== null && amount !== ''
    ? normalizePositiveDecimal(amount, 'amount')
    : null;

  let normalizedMemo = { memo: null, memoType: null };
  if (memo !== undefined && memo !== null && memo !== '') {
    normalizedMemo = normalizeSep6Memo({ memo, memoType: memoType || 'text' });
  }

  const params = {
    asset_code: code,
    account: resolvedAccount,
    ...(normalizedAmount ? { amount: normalizedAmount } : {}),
    ...(type ? { type: String(type).trim() } : {}),
    ...(normalizedMemo.memo ? { memo: normalizedMemo.memo, memo_type: normalizedMemo.memoType } : {}),
    ...(emailAddress ? { email_address: emailAddress } : {}),
    ...(walletName ? { wallet_name: walletName } : {}),
    ...(walletUrl ? { wallet_url: walletUrl } : {}),
    ...(lang ? { lang } : {}),
    ...(onChangeCallback ? { on_change_callback: onChangeCallback } : {}),
    ...(countryCode ? { country_code: countryCode } : {}),
    ...(claimableBalanceSupported !== undefined ? { claimable_balance_supported: String(Boolean(claimableBalanceSupported)) } : {}),
    ...(customerId ? { customer_id: customerId } : {}),
    ...(locationId ? { location_id: locationId } : {}),
    ...(extraFields && typeof extraFields === 'object' ? extraFields : {}),
  };

  const data = await performGet({
    url: `${baseUrl}/deposit`,
    params,
    jwt,
    operation: 'deposit',
    options,
  });

  return {
    id: data.id || null,
    how: data.how || null,
    eta: data.eta ?? null,
    minAmount: data.min_amount ?? null,
    maxAmount: data.max_amount ?? null,
    feeFixed: data.fee_fixed ?? null,
    feePercent: data.fee_percent ?? null,
    extraInfo: data.extra_info || null,
    raw: data,
  };
};

const requestWithdrawal = async (
  {
    transferServerUrl,
    assetCode,
    type,
    dest,
    destExtra,
    account,
    amount,
    memo,
    memoType,
    refundMemo,
    refundMemoType,
    lang,
    onChangeCallback,
    countryCode,
    customerId,
    locationId,
    fundingMethod,
    extraFields,
    jwt,
  } = {},
  options = {},
) => {
  const baseUrl = normalizeTransferServerUrl(transferServerUrl);
  const code = String(assetCode || '').trim();
  const withdrawType = String(type || '').trim();
  const destination = String(dest || '').trim();

  if (!code) {
    throw new Sep6Error('assetCode is required for SEP-6 withdrawal', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }
  if (!withdrawType) {
    throw new Sep6Error('type is required for SEP-6 withdrawal', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }
  if (!destination) {
    throw new Sep6Error('dest is required for SEP-6 withdrawal', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }

  const stellarAdapter = getStellarAdapter();
  if (account !== undefined && account !== null && account !== '') {
    if (!stellarAdapter.validateAddress(String(account).trim())) {
      throw new Sep6Error('account must be a valid Stellar address', {
        statusCode: 400,
        code: 'invalid_parameter',
      });
    }
  }

  const normalizedAmount = amount !== undefined && amount !== null && amount !== ''
    ? normalizePositiveDecimal(amount, 'amount')
    : null;

  if (memo !== undefined && memo !== null && memo !== '') {
    normalizeSep6Memo({ memo, memoType: memoType || 'text' });
  }
  if (refundMemo !== undefined && refundMemo !== null && refundMemo !== '') {
    normalizeSep6Memo({ memo: refundMemo, memoType: refundMemoType || 'text' });
  }

  const params = {
    asset_code: code,
    type: withdrawType,
    dest: destination,
    ...(destExtra ? { dest_extra: String(destExtra) } : {}),
    ...(account ? { account: String(account).trim() } : {}),
    ...(normalizedAmount ? { amount: normalizedAmount } : {}),
    ...(memo !== undefined && memo !== null && memo !== '' ? { memo: String(memo), memo_type: memoType || 'text' } : {}),
    ...(refundMemo ? { refund_memo: String(refundMemo), refund_memo_type: refundMemoType || 'text' } : {}),
    ...(lang ? { lang } : {}),
    ...(onChangeCallback ? { on_change_callback: onChangeCallback } : {}),
    ...(countryCode ? { country_code: countryCode } : {}),
    ...(customerId ? { customer_id: customerId } : {}),
    ...(locationId ? { location_id: locationId } : {}),
    ...(fundingMethod ? { funding_method: fundingMethod } : {}),
    ...(extraFields && typeof extraFields === 'object' ? extraFields : {}),
  };

  const data = await performGet({
    url: `${baseUrl}/withdraw`,
    params,
    jwt,
    operation: 'withdraw',
    options,
  });

  const accountId = String(data?.account_id || '').trim();
  if (!stellarAdapter.validateAddress(accountId)) {
    throw new Sep6Error('Anchor withdrawal response missing a valid Stellar account_id', {
      statusCode: 502,
      code: 'invalid_anchor_instructions',
      details: data,
    });
  }

  const hasReturnedMemo = data?.memo !== undefined && data?.memo !== null && data?.memo !== '';
  if (stellarAdapter.isMuxedAddress?.(accountId) && hasReturnedMemo) {
    throw new Sep6Error('Anchor returned conflicting muxed account_id and memo', {
      statusCode: 502,
      code: 'invalid_anchor_instructions',
      details: data,
    });
  }

  let parsedMemo = { memo: null, rawMemo: null, memoType: null };
  if (hasReturnedMemo) {
    try {
      parsedMemo = normalizeSep6Memo({
        memo: data.memo,
        memoType: data.memo_type || 'text',
      });
    } catch (err) {
      throw new Sep6Error(`Anchor returned invalid withdrawal memo: ${err.message}`, {
        statusCode: 502,
        code: 'invalid_anchor_instructions',
        details: data,
      });
    }
  }

  return {
    id: data.id || null,
    accountId,
    memo: parsedMemo.memo,
    rawMemo: parsedMemo.rawMemo,
    memoType: parsedMemo.memoType,
    eta: data.eta ?? null,
    minAmount: data.min_amount ?? null,
    maxAmount: data.max_amount ?? null,
    feeFixed: data.fee_fixed ?? null,
    feePercent: data.fee_percent ?? null,
    extraInfo: data.extra_info || null,
    raw: data,
  };
};

const requestMobileMoneyWithdrawal = async (
  {
    transferServerUrl,
    assetCode,
    rail,
    type,
    phoneNumber,
    dest,
    provider,
    destExtra,
    defaultRegion,
    ...rest
  } = {},
  options = {},
) => {
  const normalizedRail = normalizeMobileMoneyRail(rail || type || 'mobile_money');
  const rawPhone = phoneNumber || dest;
  if (!rawPhone || !String(rawPhone).trim()) {
    throw new Sep6Error('phoneNumber is required for mobile money withdrawal', {
      statusCode: 400,
      code: 'invalid_phone_number',
    });
  }

  let canonicalPhone;
  try {
    canonicalPhone = canonicalizePhoneNumber(String(rawPhone).trim(), defaultRegion);
  } catch (err) {
    throw new Sep6Error(err.message, {
      statusCode: 400,
      code: 'invalid_phone_number',
    });
  }

  const resolvedDestExtra = destExtra || (provider ? String(provider).trim() : undefined);

  return requestWithdrawal(
    {
      transferServerUrl,
      assetCode,
      type: normalizedRail,
      dest: canonicalPhone,
      destExtra: resolvedDestExtra,
      ...rest,
    },
    options,
  );
};

const requestBankWithdrawal = async (
  {
    transferServerUrl,
    assetCode,
    type = 'bank_account',
    accountNumber,
    dest,
    bankCode,
    routingCode,
    destExtra,
    ...rest
  } = {},
  options = {},
) => {
  const bankType = String(type || 'bank_account').trim().toLowerCase();
  if (!BANK_WITHDRAWAL_RAILS.has(bankType)) {
    throw new Sep6Error(
      `Unsupported bank withdrawal type: ${type}. Supported: ${Array.from(BANK_WITHDRAWAL_RAILS).join(', ')}`,
      {
        statusCode: 400,
        code: 'unsupported_bank_rail',
      },
    );
  }

  const resolvedDest = String(accountNumber || dest || '').trim();
  if (!resolvedDest) {
    throw new Sep6Error('accountNumber or dest is required for bank withdrawal', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }

  let resolvedDestExtra = destExtra;
  if (!resolvedDestExtra && (bankCode || routingCode)) {
    resolvedDestExtra = bankCode && routingCode
      ? JSON.stringify({ bankCode: String(bankCode).trim(), routingCode: String(routingCode).trim() })
      : String(bankCode || routingCode).trim();
  }

  return requestWithdrawal(
    {
      transferServerUrl,
      assetCode,
      type: bankType,
      dest: resolvedDest,
      destExtra: resolvedDestExtra,
      ...rest,
    },
    options,
  );
};

const executeProgrammaticWithdrawal = async (
  {
    transferServerUrl,
    assetCode,
    rail,
    type,
    phoneNumber,
    accountNumber,
    dest,
    destExtra,
    bankCode,
    routingCode,
    account,
    amount,
    wallet,
    secretKey,
    userId,
    idempotencyKey,
    ...rest
  } = {},
  options = {},
) => {
  const normalizedAmount = normalizePositiveDecimal(amount, 'amount');
  const typeKey = String(type || '').trim().toLowerCase();

  let instructions;
  if (rail || MOBILE_MONEY_RAIL_ALIASES[typeKey]) {
    instructions = await requestMobileMoneyWithdrawal(
      {
        transferServerUrl,
        assetCode,
        rail,
        type,
        phoneNumber,
        dest,
        destExtra,
        account,
        amount: normalizedAmount,
        ...rest,
      },
      options,
    );
  } else if (accountNumber || bankCode || routingCode || BANK_WITHDRAWAL_RAILS.has(typeKey)) {
    instructions = await requestBankWithdrawal(
      {
        transferServerUrl,
        assetCode,
        type: type || 'bank_account',
        accountNumber,
        dest,
        bankCode,
        routingCode,
        destExtra,
        account,
        amount: normalizedAmount,
        ...rest,
      },
      options,
    );
  } else {
    instructions = await requestWithdrawal(
      {
        transferServerUrl,
        assetCode,
        type,
        dest,
        destExtra,
        account,
        amount: normalizedAmount,
        ...rest,
      },
      options,
    );
  }

  let payment;
  const submitArgs = {
    destination: instructions.accountId,
    amount: normalizedAmount,
    asset: assetCode,
    memo: instructions.memo,
    memoType: instructions.memoType,
  };

  if (typeof options.submitPayment === 'function') {
    payment = await options.submitPayment({ wallet, secretKey, ...submitArgs });
  } else if (wallet) {
    payment = await getWalletService().submitPayment({ wallet, ...submitArgs });
  } else if (secretKey) {
    payment = await getStellarAdapter().submitPayment({ secretKey, ...submitArgs });
  } else {
    throw new Sep6Error('wallet, secretKey, or submitPayment handler is required to execute withdrawal', {
      statusCode: 400,
      code: 'missing_signing_credentials',
    });
  }

  const prismaClient = options.prisma !== undefined
    ? options.prisma
    : (userId ? getDefaultPrisma() : null);

  let transaction = null;
  if (userId && prismaClient?.transaction?.create) {
    transaction = await prismaClient.transaction.create({
      data: {
        userId,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        type: 'withdraw',
        amount: normalizedAmount,
        asset: String(assetCode).trim(),
        rail: 'sep6',
        routeType: 'off_ramp',
        destination: instructions.accountId,
        recipientPhoneNumber: phoneNumber ? String(phoneNumber).trim() : null,
        txHash: payment?.txHash || null,
        providerTransactionId: instructions.id || null,
        explorerUrl: payment?.explorerUrl || null,
        status: 'pending',
        metadata: {
          sep6: {
            anchorTransactionId: instructions.id || null,
            type: type || rail || null,
            dest: phoneNumber || accountNumber || dest || null,
            memo: instructions.memo,
            memoType: instructions.memoType,
            eta: instructions.eta,
          },
        },
      },
    });
  }

  const writeAuditLog = options.writeAuditLog || getDefaultAuditLogger();
  if (typeof writeAuditLog === 'function') {
    await writeAuditLog({
      actorType: userId ? 'user' : 'system',
      actorId: String(userId || 'sep6'),
      action: 'sep6.withdrawal.submitted',
      entityType: 'Transaction',
      entityId: String(transaction?.id || instructions.id || payment?.txHash || 'sep6'),
      metadata: {
        assetCode,
        amount: normalizedAmount,
        accountId: instructions.accountId,
        anchorTransactionId: instructions.id || null,
        txHash: payment?.txHash || null,
      },
    }).catch((err) => logger.warn('sep6_audit_log_failed', { message: err.message }));
  }

  return {
    instructions,
    payment,
    transaction,
  };
};

const getTransaction = async (
  { transferServerUrl, id, stellarTransactionId, externalTransactionId, lang, jwt } = {},
  options = {},
) => {
  const baseUrl = normalizeTransferServerUrl(transferServerUrl);
  if (!id && !stellarTransactionId && !externalTransactionId) {
    throw new Sep6Error('id, stellarTransactionId, or externalTransactionId is required', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }

  const params = {
    ...(id ? { id } : {}),
    ...(stellarTransactionId ? { stellar_transaction_id: stellarTransactionId } : {}),
    ...(externalTransactionId ? { external_transaction_id: externalTransactionId } : {}),
    ...(lang ? { lang } : {}),
  };

  const data = await performGet({
    url: `${baseUrl}/transaction`,
    params,
    jwt,
    operation: 'transaction',
    options,
  });

  return data.transaction || data;
};

const getTransactions = async (
  { transferServerUrl, assetCode, account, noOlderThan, limit, kind, pagingId, lang, jwt } = {},
  options = {},
) => {
  const baseUrl = normalizeTransferServerUrl(transferServerUrl);
  const code = String(assetCode || '').trim();
  const resolvedAccount = String(account || '').trim();
  if (!code || !resolvedAccount) {
    throw new Sep6Error('assetCode and account are required to list SEP-6 transactions', {
      statusCode: 400,
      code: 'invalid_parameter',
    });
  }

  const params = {
    asset_code: code,
    account: resolvedAccount,
    ...(noOlderThan ? { no_older_than: noOlderThan } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(kind ? { kind } : {}),
    ...(pagingId ? { paging_id: pagingId } : {}),
    ...(lang ? { lang } : {}),
  };

  const data = await performGet({
    url: `${baseUrl}/transactions`,
    params,
    jwt,
    operation: 'transactions',
    options,
  });

  return Array.isArray(data.transactions) ? data.transactions : [];
};

module.exports = {
  MOBILE_MONEY_RAILS,
  MOBILE_MONEY_RAIL_ALIASES,
  BANK_WITHDRAWAL_RAILS,
  Sep6Error,
  normalizeTransferServerUrl,
  normalizePositiveDecimal,
  normalizeMobileMoneyRail,
  normalizeSep6Memo,
  getInfo,
  getFee,
  requestDeposit,
  requestWithdrawal,
  requestMobileMoneyWithdrawal,
  requestBankWithdrawal,
  executeProgrammaticWithdrawal,
  getTransaction,
  getTransactions,
};
