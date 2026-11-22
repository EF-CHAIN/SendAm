const crypto = require('crypto');
const axios = require('axios');
const config = require('../../config/env');
const { ProviderSkippedError } = require('../providerErrors');
const { outboundHeaders } = require('../../observability/context');

function getSmileIdConfig() {
  const smile = config.compliance.smileId;
  if (!smile.partnerId || !smile.apiKey || !smile.callbackUrl) {
    return null;
  }
  return smile;
}

function signatureFor(timestamp) {
  const smile = getSmileIdConfig();
  if (!smile) return null;
  return crypto
    .createHmac('sha256', smile.apiKey)
    .update(timestamp, 'utf8')
    .update(String(smile.partnerId), 'utf8')
    .update('sid_request', 'utf8')
    .digest('base64');
}

async function submitBvnVerification({ jobId, _userId, phoneNumber, applicant }) {
  const smile = getSmileIdConfig();
  if (!smile) throw new ProviderSkippedError('Smile ID KYC is not configured');

  const timestamp = new Date().toISOString();
  const payload = {
    source_sdk: 'rest_api',
    source_sdk_version: 'sendam-1.0',
    partner_id: String(smile.partnerId),
    signature: signatureFor(timestamp),
    timestamp,
    callback_url: smile.callbackUrl,
    partner_params: { job_id: jobId, user_id: _userId, job_type: 5 },
    phone_number: phoneNumber,
    country: applicant.country,
    id_type: 'BVN',
    id_number: applicant.bvn,
    first_name: applicant.firstName,
    last_name: applicant.lastName,
    ...(applicant.middleName && { middle_name: applicant.middleName }),
    ...(applicant.dob && { dob: applicant.dob }),
    ...(applicant.gender && { gender: applicant.gender }),
  };

  const response = await axios.post(smile.baseUrl, payload, {
    timeout: smile.timeoutMs,
    headers: { 'content-type': 'application/json', ...outboundHeaders() },
  });
  if (!response.data?.success) {
    throw new Error(`Smile ID rejected BVN submission${response.data?.error ? `: ${response.data.error}` : ''}`);
  }
  return { accepted: true, providerReference: response.data?.job_id || jobId };
}

async function submitNinVerification({ jobId, _userId, phoneNumber, applicant }) {
  const smile = getSmileIdConfig();
  if (!smile) throw new ProviderSkippedError('Smile ID KYC is not configured');

  const timestamp = new Date().toISOString();
  const payload = {
    source_sdk: 'rest_api',
    source_sdk_version: 'sendam-1.0',
    partner_id: String(smile.partnerId),
    signature: signatureFor(timestamp),
    timestamp,
    callback_url: smile.callbackUrl,
    partner_params: { job_id: jobId, user_id: _userId, job_type: 5 },
    phone_number: phoneNumber,
    country: applicant.country,
    id_type: 'NIN',
    id_number: applicant.nin,
    first_name: applicant.firstName,
    last_name: applicant.lastName,
    ...(applicant.middleName && { middle_name: applicant.middleName }),
    ...(applicant.dob && { dob: applicant.dob }),
    ...(applicant.gender && { gender: applicant.gender }),
  };

  const response = await axios.post(smile.baseUrl, payload, {
    timeout: smile.timeoutMs,
    headers: { 'content-type': 'application/json', ...outboundHeaders() },
  });
  if (!response.data?.success) {
    throw new Error(`Smile ID rejected NIN submission${response.data?.error ? `: ${response.data.error}` : ''}`);
  }
  return { accepted: true, providerReference: response.data?.job_id || jobId };
}

function verifyCallback({ signature, timestamp }) {
  const smile = getSmileIdConfig();
  if (!smile || !smile.apiKey || !smile.partnerId) return false;
  if (!signature || !timestamp) return false;

  const callbackTime = Date.parse(timestamp);
  if (!Number.isFinite(callbackTime) || Math.abs(Date.now() - callbackTime) > smile.callbackToleranceMs) return false;

  const expected = Buffer.from(signatureFor(timestamp));
  const received = Buffer.from(String(signature));
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

async function deleteSubject({ userId, providerReference }) {
  const url = config.compliance.smileId.dataDeletionUrl || process.env.SMILE_ID_DATA_DELETION_URL;
  if (!url) throw new ProviderSkippedError('Smile ID data deletion not configured');
  await axios.post(url, { user_id: userId, job_id: providerReference }, {
    timeout: config.compliance.smileId.timeoutMs,
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${config.compliance.smileId.apiKey}`, ...outboundHeaders() },
  });
  return { status: 'success' };
}

module.exports = {
  submitBvnVerification,
  submitNinVerification,
  verifyCallback,
  signatureFor,
  deleteSubject,
};