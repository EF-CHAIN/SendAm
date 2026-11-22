const axios = require('axios');
const config = require('../../config/env');
const { ProviderSkippedError } = require('../providerErrors');
const { outboundHeaders } = require('../../observability/context');

function getDojahConfig() {
  const dojah = config.compliance.dojah;
  if (!dojah.appId || !dojah.secretKey) {
    return null;
  }
  return dojah;
}

async function getDojahToken() {
  const dojah = getDojahConfig();
  if (!dojah) return null;

  const response = await axios.post('https://api.dojah.io/api/v1/auth/token', {
    app_id: dojah.appId,
    secret_key: dojah.secretKey,
  }, { timeout: 10000, headers: { 'content-type': 'application/json', ...outboundHeaders() } });

  if (!response.data?.entity?.access_token) {
    throw new Error('Failed to obtain Dojah access token');
  }
  return response.data.entity.access_token;
}

async function submitNinVerification({ jobId, userId, phoneNumber, applicant }) {
  const dojah = getDojahConfig();
  if (!dojah) throw new ProviderSkippedError('Dojah KYC is not configured');

  const token = await getDojahToken();
  const payload = {
    nin: applicant.nin,
    firstname: applicant.firstName,
    lastname: applicant.lastName,
    ...(applicant.middleName && { middlename: applicant.middleName }),
    ...(applicant.dob && { dob: applicant.dob }),
    phone_number: phoneNumber,
  };

  const response = await axios.post('https://api.dojah.io/api/v1/kyc/nin', payload, {
    timeout: 30000,
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}`, ...outboundHeaders() },
  });

  if (!response.data?.entity?.verified) {
    throw new Error(`Dojah rejected NIN verification${response.data?.entity?.message ? `: ${response.data.entity.message}` : ''}`);
  }

  return { accepted: true, providerReference: response.data?.entity?.reference || jobId };
}

async function submitBvnVerification({ jobId, userId, phoneNumber, applicant }) {
  const dojah = getDojahConfig();
  if (!dojah) throw new ProviderSkippedError('Dojah KYC is not configured');

  const token = await getDojahToken();
  const payload = {
    bvn: applicant.bvn,
    firstname: applicant.firstName,
    lastname: applicant.lastName,
    ...(applicant.middleName && { middlename: applicant.middleName }),
    ...(applicant.dob && { dob: applicant.dob }),
    phone_number: phoneNumber,
  };

  const response = await axios.post('https://api.dojah.io/api/v1/kyc/bvn', payload, {
    timeout: 30000,
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}`, ...outboundHeaders() },
  });

  if (!response.data?.entity?.verified) {
    throw new Error(`Dojah rejected BVN verification${response.data?.entity?.message ? `: ${response.data.entity.message}` : ''}`);
  }

  return { accepted: true, providerReference: response.data?.entity?.reference || jobId };
}

module.exports = {
  submitBvnVerification,
  submitNinVerification,
};