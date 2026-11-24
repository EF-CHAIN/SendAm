'use strict';

// Dojah identity lookup for Nigerian BVN / NIN (#982).
//
// Dojah's KYC lookups are synchronous: the identity record comes back in the
// response, so SendAm can compare name and date of birth and decide at once.
// Auth is the `AppId` + `Authorization` (secret key) header pair.
//
// Before enabling in production, confirm the endpoint paths and response
// fields against Dojah's sandbox (DOJAH_BASE_URL=https://sandbox.dojah.io);
// the normalizer below accepts the field spellings Dojah has used.

const axios = require('axios');
const config = require('../../config/env');
const { outboundHeaders } = require('../../observability/context');

const LOOKUP_PATHS = Object.freeze({
  BVN: { path: '/api/v1/kyc/bvn/full', param: 'bvn' },
  NIN: { path: '/api/v1/kyc/nin', param: 'nin' },
});

class IdentityNotFoundError extends Error {
  constructor(message = 'Identity record not found') {
    super(message);
    this.name = 'IdentityNotFoundError';
  }
}

const getDojahConfig = () => {
  const dojah = config.compliance.dojah || {};
  if (!dojah.appId || !dojah.secretKey) return null;
  return dojah;
};

const isConfigured = () => Boolean(getDojahConfig());

const pick = (obj, ...keys) => {
  for (const key of keys) {
    if (obj?.[key] !== undefined && obj[key] !== null && String(obj[key]).trim() !== '') return String(obj[key]).trim();
  }
  return null;
};

const normalizeIdentity = (entity) => ({
  firstName: pick(entity, 'first_name', 'firstname', 'firstName'),
  middleName: pick(entity, 'middle_name', 'middlename', 'middleName'),
  lastName: pick(entity, 'last_name', 'lastname', 'surname', 'lastName'),
  dob: pick(entity, 'date_of_birth', 'dob', 'birthdate', 'birth_date'),
  reference: pick(entity, 'reference', 'reference_id', 'request_id'),
});

/**
 * Looks up a BVN or NIN. Resolves to the normalized identity record; rejects
 * with IdentityNotFoundError when Dojah reports no such ID, or with the
 * transport/provider error otherwise (callers treat that as retryable).
 */
const lookupIdentity = async ({ idType, idNumber }, { httpGet } = {}) => {
  const dojah = getDojahConfig();
  if (!dojah) {
    const error = new Error('Dojah KYC is not configured');
    error.statusCode = 503;
    throw error;
  }
  const lookup = LOOKUP_PATHS[idType];
  if (!lookup) throw new Error(`Unsupported ID type: ${idType}`);

  const url = `${dojah.baseUrl.replace(/\/$/, '')}${lookup.path}`;
  const get = httpGet || ((u, opts) => axios.get(u, opts));
  let response;
  try {
    response = await get(url, {
      params: { [lookup.param]: idNumber },
      timeout: dojah.timeoutMs,
      headers: { AppId: dojah.appId, Authorization: dojah.secretKey, ...outboundHeaders() },
    });
  } catch (error) {
    const status = error.response?.status;
    if (status === 400 || status === 404) {
      throw new IdentityNotFoundError(error.response?.data?.error || 'Identity record not found');
    }
    throw error;
  }

  const entity = response?.data?.entity;
  if (!entity || typeof entity !== 'object') throw new IdentityNotFoundError();
  return normalizeIdentity(entity);
};

module.exports = {
  LOOKUP_PATHS,
  IdentityNotFoundError,
  isConfigured,
  normalizeIdentity,
  lookupIdentity,
};
