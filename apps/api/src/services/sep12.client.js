'use strict';

const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');
const { outboundHeaders } = require('../observability/context');

const SEP12_STATUSES = Object.freeze({
  ACCEPTED: 'ACCEPTED',
  PROCESSING: 'PROCESSING',
  NEEDS_INFO: 'NEEDS_INFO',
  REJECTED: 'REJECTED',
});

// Mapping from SendAm KYC ID types (Smile ID / Dojah / African corridors)
// to standard SEP-9 id_type values expected by Stellar SEP-12 anchors.
const ID_TYPE_MAP = Object.freeze({
  BVN: 'tax_id',
  NIN: 'national_id',
  NATIONAL_ID: 'national_id',
  GHANA_CARD: 'national_id',
  KENYA_ID: 'national_id',
  HUDUMA_NAMBA: 'national_id',
  PASSPORT: 'passport',
  INTERNATIONAL_PASSPORT: 'passport',
  DRIVERS_LICENSE: 'drivers_license',
  DRIVER_LICENSE: 'drivers_license',
  VOTER_ID: 'voter_id',
  VOTERS_CARD: 'voter_id',
  TAX_ID: 'tax_id',
  TIN: 'tax_id',
});

class Sep12Error extends Error {
  constructor(message, { statusCode = 502, code = 'sep12_error', anchorError = null, details = null } = {}) {
    super(message);
    this.name = 'Sep12Error';
    this.statusCode = statusCode;
    this.code = code;
    this.anchorError = anchorError;
    this.details = details;
  }
}

const normalizeServerUrl = (serverUrl) => {
  const raw = String(serverUrl || config?.stellar?.sep12Url || '').trim();
  if (!raw) {
    throw new Sep12Error('SEP-12 KYC server URL is required', {
      statusCode: 400,
      code: 'missing_kyc_server_url',
    });
  }
  return raw.replace(/\/+$/, '');
};

const normalizeJwt = (jwt) => {
  const token = String(jwt || '').trim().replace(/^Bearer\s+/i, '');
  if (!token) {
    throw new Sep12Error('SEP-10 JWT bearer token is required for SEP-12 requests', {
      statusCode: 401,
      code: 'missing_sep10_jwt',
    });
  }
  return token;
};

const mapIdTypeToSep9 = (idType) => {
  if (!idType) return null;
  const raw = String(idType).trim();
  if (!raw) return null;
  const upper = raw.toUpperCase().replace(/[\s-]+/g, '_');
  if (ID_TYPE_MAP[upper]) {
    return ID_TYPE_MAP[upper];
  }
  return raw.toLowerCase().replace(/[\s-]+/g, '_');
};

const pickFirstNonEmpty = (...values) => {
  for (const val of values) {
    if (val !== undefined && val !== null) {
      const trimmed = String(val).trim();
      if (trimmed !== '') return trimmed;
    }
  }
  return null;
};

/**
 * Maps a SendAm KycProfile (and optional User / extra fields) to standard
 * SEP-9 / SEP-12 customer identity fields for anchor KYC submission.
 */
const mapKycProfileToSep12 = (profile = {}, user = {}, extraFields = {}) => {
  if (!profile || typeof profile !== 'object') {
    throw new Sep12Error('A valid KycProfile object is required', {
      statusCode: 400,
      code: 'invalid_kyc_profile',
    });
  }

  const metadata = (profile.metadata && typeof profile.metadata === 'object') ? profile.metadata : {};
  const applicant = (metadata.applicant && typeof metadata.applicant === 'object') ? metadata.applicant : {};

  const firstName = pickFirstNonEmpty(
    extraFields.first_name,
    extraFields.firstName,
    profile.firstName,
    profile.first_name,
    applicant.firstName,
    applicant.first_name,
    metadata.firstName,
    metadata.first_name,
    user?.firstName,
    user?.first_name,
  );

  const lastName = pickFirstNonEmpty(
    extraFields.last_name,
    extraFields.lastName,
    profile.lastName,
    profile.last_name,
    applicant.lastName,
    applicant.last_name,
    metadata.lastName,
    metadata.last_name,
    user?.lastName,
    user?.last_name,
  );

  const rawIdType = pickFirstNonEmpty(
    extraFields.id_type,
    extraFields.idType,
    profile.idType,
    profile.id_type,
    applicant.idType,
    applicant.id_type,
    metadata.idType,
    metadata.id_type,
  );
  const idType = mapIdTypeToSep9(rawIdType);

  const idNumber = pickFirstNonEmpty(
    extraFields.id_number,
    extraFields.idNumber,
    profile.idNumber,
    profile.id_number,
    applicant.idNumber,
    applicant.id_number,
    metadata.idNumber,
    metadata.id_number,
  );

  const countryCode = pickFirstNonEmpty(
    extraFields.id_country_code,
    extraFields.country,
    profile.country,
    applicant.country,
    metadata.country,
    user?.country,
  );

  const mobileNumber = pickFirstNonEmpty(
    extraFields.mobile_number,
    extraFields.phoneNumber,
    user?.phoneNumber,
    profile.phoneNumber,
    applicant.phoneNumber,
    metadata.phoneNumber,
  );

  const emailAddress = pickFirstNonEmpty(
    extraFields.email_address,
    extraFields.email,
    user?.email,
    profile.email,
    applicant.email,
    metadata.email,
  );

  const birthDate = pickFirstNonEmpty(
    extraFields.birth_date,
    extraFields.birthDate,
    extraFields.dateOfBirth,
    profile.birthDate,
    profile.dateOfBirth,
    applicant.birthDate,
    applicant.dateOfBirth,
    metadata.birthDate,
    metadata.dateOfBirth,
  );

  const address = pickFirstNonEmpty(
    extraFields.address,
    profile.address,
    applicant.address,
    metadata.address,
  );

  const bankAccountNumber = pickFirstNonEmpty(
    extraFields.bank_account_number,
    extraFields.bankAccountNumber,
    metadata.bankAccountNumber,
    metadata.bank_account_number,
  );

  const bankNumber = pickFirstNonEmpty(
    extraFields.bank_number,
    extraFields.bankCode,
    extraFields.bankNumber,
    metadata.bankCode,
    metadata.bank_number,
  );

  const payload = {};

  if (firstName) payload.first_name = firstName;
  if (lastName) payload.last_name = lastName;
  if (idType) payload.id_type = idType;
  if (idNumber) payload.id_number = idNumber;
  if (countryCode) {
    payload.id_country_code = countryCode.toUpperCase();
    payload.address_country_code = (extraFields.address_country_code || countryCode).toUpperCase();
  }
  if (mobileNumber) payload.mobile_number = mobileNumber;
  if (emailAddress) payload.email_address = emailAddress;
  if (birthDate) payload.birth_date = birthDate;
  if (address) payload.address = address;
  if (bankAccountNumber) payload.bank_account_number = bankAccountNumber;
  if (bankNumber) payload.bank_number = bankNumber;

  const account = pickFirstNonEmpty(extraFields.account, profile.account, user?.publicKey);
  if (account) payload.account = account;

  const customerId = pickFirstNonEmpty(extraFields.id, metadata.sep12CustomerId);
  if (customerId) payload.id = customerId;

  const memo = pickFirstNonEmpty(extraFields.memo, metadata.memo);
  if (memo) payload.memo = memo;

  const memoType = pickFirstNonEmpty(extraFields.memo_type, extraFields.memoType, metadata.memoType);
  if (memoType) payload.memo_type = memoType;

  const customerType = pickFirstNonEmpty(extraFields.type, metadata.sep12CustomerType);
  if (customerType) payload.type = customerType;

  return payload;
};

const validateRequiredSep12Fields = (payload) => {
  const required = ['first_name', 'last_name', 'id_type', 'id_number'];
  const missing = required.filter((field) => !payload[field] || !String(payload[field]).trim());
  if (missing.length > 0) {
    throw new Sep12Error(`Missing required SEP-12 KYC fields: ${missing.join(', ')}`, {
      statusCode: 400,
      code: 'missing_required_kyc_fields',
      details: { missing },
    });
  }
};

const wrapAxiosError = (error, operation) => {
  if (error instanceof Sep12Error) return error;
  const status = error?.response?.status;
  const anchorError = error?.response?.data?.error || error?.response?.data?.message || null;
  if (status) {
    return new Sep12Error(
      anchorError || `SEP-12 ${operation} failed with status ${status}`,
      {
        statusCode: status,
        code: status === 401 || status === 403 ? 'sep12_unauthorized' : 'sep12_anchor_error',
        anchorError,
        details: error.response?.data || null,
      },
    );
  }
  return new Sep12Error(
    `SEP-12 ${operation} network error: ${error?.message || 'unknown error'}`,
    {
      statusCode: 502,
      code: 'sep12_network_error',
    },
  );
};

/**
 * Queries customer KYC status and required/provided fields from a SEP-12 anchor (`GET /customer`).
 */
const getCustomer = async (params = {}, options = {}) => {
  const {
    kycServerUrl,
    serverUrl,
    jwt,
    token,
    id,
    account,
    memo,
    memoType,
    memo_type,
    type,
    lang,
  } = params;

  const baseUrl = normalizeServerUrl(kycServerUrl || serverUrl || options.kycServerUrl);
  const bearerToken = normalizeJwt(jwt || token || options.jwt);
  const axiosImpl = options.axiosImpl || params.axiosImpl || axios;
  const timeoutMs = Number(options.timeoutMs || config?.requestLimits?.upstreamTimeoutMs || 10000);

  const query = {};
  if (id) query.id = String(id);
  if (account) query.account = String(account);
  if (memo) query.memo = String(memo);
  if (memoType || memo_type) query.memo_type = String(memoType || memo_type);
  if (type) query.type = String(type);
  if (lang) query.lang = String(lang);

  try {
    const response = await axiosImpl.get(`${baseUrl}/customer`, {
      params: query,
      timeout: timeoutMs,
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: 'application/json',
        ...outboundHeaders(),
      },
    });

    const data = response?.data || {};
    return {
      id: data.id || null,
      status: data.status || SEP12_STATUSES.NEEDS_INFO,
      fields: data.fields || {},
      providedFields: data.provided_fields || data.providedFields || {},
      message: data.message || null,
      raw: data,
    };
  } catch (error) {
    const wrapped = wrapAxiosError(error, 'GET /customer');
    logger.warn('sep12_get_customer_failed', {
      baseUrl,
      statusCode: wrapped.statusCode,
      message: wrapped.message,
    });
    throw wrapped;
  }
};

/**
 * Submits or updates customer KYC fields at a SEP-12 anchor (`PUT /customer`).
 */
const putCustomer = async (params = {}, options = {}) => {
  const {
    kycServerUrl,
    serverUrl,
    jwt,
    token,
    id,
    account,
    memo,
    memoType,
    memo_type,
    type,
    profile,
    user,
    fields = {},
    allowPartial = false,
  } = params;

  const baseUrl = normalizeServerUrl(kycServerUrl || serverUrl || options.kycServerUrl);
  const bearerToken = normalizeJwt(jwt || token || options.jwt);
  const axiosImpl = options.axiosImpl || params.axiosImpl || axios;
  const timeoutMs = Number(options.timeoutMs || config?.requestLimits?.upstreamTimeoutMs || 10000);

  let payload;
  if (profile) {
    payload = mapKycProfileToSep12(profile, user, {
      ...fields,
      ...(id ? { id } : {}),
      ...(account ? { account } : {}),
      ...(memo ? { memo } : {}),
      ...(memoType || memo_type ? { memo_type: memoType || memo_type } : {}),
      ...(type ? { type } : {}),
    });
  } else {
    payload = mapKycProfileToSep12({}, user, {
      ...fields,
      ...(id ? { id } : {}),
      ...(account ? { account } : {}),
      ...(memo ? { memo } : {}),
      ...(memoType || memo_type ? { memo_type: memoType || memo_type } : {}),
      ...(type ? { type } : {}),
    });
  }

  // Merge any additional custom SEP-9 keys passed in `fields`
  for (const [key, value] of Object.entries(fields || {})) {
    if (value !== undefined && value !== null && payload[key] === undefined) {
      payload[key] = value;
    }
  }

  if (!allowPartial) {
    validateRequiredSep12Fields(payload);
  }

  try {
    const response = await axiosImpl.put(`${baseUrl}/customer`, payload, {
      timeout: timeoutMs,
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...outboundHeaders(),
      },
    });

    const data = response?.data || {};
    if (!data.id) {
      throw new Sep12Error('Anchor SEP-12 PUT /customer response did not include a customer id', {
        statusCode: 502,
        code: 'invalid_anchor_response',
        details: data,
      });
    }

    return {
      id: String(data.id),
      status: data.status || SEP12_STATUSES.PROCESSING,
      submittedFields: Object.keys(payload),
      raw: data,
    };
  } catch (error) {
    const wrapped = wrapAxiosError(error, 'PUT /customer');
    logger.warn('sep12_put_customer_failed', {
      baseUrl,
      statusCode: wrapped.statusCode,
      message: wrapped.message,
    });
    throw wrapped;
  }
};

/**
 * High-level helper that maps a SendAm KycProfile, submits it to the anchor's
 * SEP-12 endpoint, and optionally records the returned customer ID in KycProfile.metadata.
 */
const submitKycProfile = async (params = {}, options = {}) => {
  const {
    kycServerUrl,
    serverUrl,
    jwt,
    token,
    profile,
    user,
    account,
    memo,
    type,
    extraFields = {},
  } = params;

  if (!profile) {
    throw new Sep12Error('KycProfile is required to submit KYC data', {
      statusCode: 400,
      code: 'missing_kyc_profile',
    });
  }

  const result = await putCustomer({
    kycServerUrl: kycServerUrl || serverUrl,
    jwt: jwt || token,
    profile,
    user,
    account,
    memo,
    type,
    fields: extraFields,
  }, options);

  const prismaClient = options.prisma || params.prisma || null;
  if (prismaClient?.kycProfile?.update && profile.id) {
    const existingMeta = (profile.metadata && typeof profile.metadata === 'object')
      ? profile.metadata
      : {};
    await prismaClient.kycProfile.update({
      where: { id: profile.id },
      data: {
        metadata: {
          ...existingMeta,
          sep12CustomerId: result.id,
          sep12Status: result.status,
          sep12SubmittedAt: new Date().toISOString(),
        },
      },
    });
  }

  return result;
};

/**
 * Deletes customer KYC data from a SEP-12 anchor (`DELETE /customer/:account`).
 */
const deleteCustomer = async (params = {}, options = {}) => {
  const {
    kycServerUrl,
    serverUrl,
    jwt,
    token,
    account,
    memo,
    memoType,
    memo_type,
  } = params;

  if (!account || !String(account).trim()) {
    throw new Sep12Error('Stellar account is required to delete SEP-12 customer data', {
      statusCode: 400,
      code: 'missing_account',
    });
  }

  const baseUrl = normalizeServerUrl(kycServerUrl || serverUrl || options.kycServerUrl);
  const bearerToken = normalizeJwt(jwt || token || options.jwt);
  const axiosImpl = options.axiosImpl || params.axiosImpl || axios;
  const timeoutMs = Number(options.timeoutMs || config?.requestLimits?.upstreamTimeoutMs || 10000);

  const body = {};
  if (memo) body.memo = String(memo);
  if (memoType || memo_type) body.memo_type = String(memoType || memo_type);

  try {
    await axiosImpl.delete(`${baseUrl}/customer/${encodeURIComponent(String(account).trim())}`, {
      data: Object.keys(body).length ? body : undefined,
      timeout: timeoutMs,
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
        ...outboundHeaders(),
      },
    });
    return { deleted: true, account: String(account).trim() };
  } catch (error) {
    throw wrapAxiosError(error, 'DELETE /customer');
  }
};

const createSep12Client = (defaultOptions = {}) => ({
  getCustomer: (params = {}, options = {}) => getCustomer(params, { ...defaultOptions, ...options }),
  putCustomer: (params = {}, options = {}) => putCustomer(params, { ...defaultOptions, ...options }),
  submitKycProfile: (params = {}, options = {}) => submitKycProfile(params, { ...defaultOptions, ...options }),
  deleteCustomer: (params = {}, options = {}) => deleteCustomer(params, { ...defaultOptions, ...options }),
  mapKycProfileToSep12,
});

module.exports = {
  SEP12_STATUSES,
  ID_TYPE_MAP,
  Sep12Error,
  mapIdTypeToSep9,
  mapKycProfileToSep12,
  getCustomer,
  putCustomer,
  submitKycProfile,
  deleteCustomer,
  createSep12Client,
};
