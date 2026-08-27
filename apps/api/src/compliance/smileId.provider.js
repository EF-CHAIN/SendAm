const crypto = require('crypto');
const axios = require('axios');
const config = require('../config/env');
const { ProviderSkippedError } = require('./providerErrors');
const { outboundHeaders } = require('../observability/context');

const signatureFor = (timestamp) => crypto
  .createHmac('sha256', config.compliance.smileId.apiKey)
  .update(timestamp, 'utf8')
  .update(String(config.compliance.smileId.partnerId), 'utf8')
  .update('sid_request', 'utf8')
  .digest('base64');

const assertConfigured = () => {
  const smile = config.compliance.smileId;
  if (!smile.partnerId || !smile.apiKey || !smile.callbackUrl) {
    const error = new Error('Smile ID KYC is not configured');
    error.statusCode = 503;
    throw error;
  }
};

const submitVerification = async ({ jobId, userId, phoneNumber, applicant }) => {
  assertConfigured();
  const timestamp = new Date().toISOString();
  const payload = {
    source_sdk: 'rest_api',
    source_sdk_version: 'sendam-1.0',
    partner_id: String(config.compliance.smileId.partnerId),
    signature: signatureFor(timestamp),
    timestamp,
    callback_url: config.compliance.smileId.callbackUrl,
    partner_params: { job_id: jobId, user_id: userId, job_type: 5 },
    phone_number: phoneNumber,
    country: applicant.country,
    id_type: applicant.idType,
    id_number: applicant.idNumber,
    first_name: applicant.firstName,
    last_name: applicant.lastName,
    ...(applicant.middleName && { middle_name: applicant.middleName }),
    ...(applicant.dob && { dob: applicant.dob }),
    ...(applicant.gender && { gender: applicant.gender }),
  };

  const response = await axios.post(config.compliance.smileId.baseUrl, payload, {
    timeout: config.compliance.smileId.timeoutMs,
    headers: { 'content-type': 'application/json', ...outboundHeaders() },
  });
  if (!response.data?.success) {
    throw new Error(`Smile ID rejected KYC submission${response.data?.error ? `: ${response.data.error}` : ''}`);
  }
  return { accepted: true };
};

const verifyCallback = ({ signature, timestamp }) => {
  if (!signature || !timestamp || !config.compliance.smileId.apiKey || !config.compliance.smileId.partnerId) return false;
  const callbackTime = Date.parse(timestamp);
  if (!Number.isFinite(callbackTime)
    || Math.abs(Date.now() - callbackTime) > config.compliance.smileId.callbackToleranceMs) return false;

  const expected = Buffer.from(signatureFor(timestamp));
  const received = Buffer.from(String(signature));
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
};

// Best-effort subject deletion at the KYC provider. Smile ID has no public
// "delete" endpoint in the basic API, so this is gated behind an operator-
// configured deletion URL. When unconfigured it throws ProviderSkippedError
// so the privacy workflow records a visible "skipped" task instead of failing.
const deleteSubject = async ({ userId, providerReference }) => {
  const url = config.compliance.smileId.dataDeletionUrl || process.env.SMILE_ID_DATA_DELETION_URL;
  if (!url) throw new ProviderSkippedError('Smile ID data deletion not configured');
  await axios.post(url, { user_id: userId, job_id: providerReference }, {
    timeout: config.compliance.smileId.timeoutMs,
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${config.compliance.smileId.apiKey}`, ...outboundHeaders() },
  });
  return { status: 'success' };
};

module.exports = { submitVerification, verifyCallback, signatureFor, deleteSubject };
