const axios = require('axios');
const config = require('../config/env');

const client = () => {
  if (!config.openfort.secretKey) {
    throw new Error('Openfort is not configured. Set OPENFORT_SECRET_KEY.');
  }
  return axios.create({
    baseURL: config.openfort.apiUrl,
    headers: {
      Authorization: `Bearer ${config.openfort.secretKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });
};

const createManagedWallet = async ({ phoneNumber }) => {
  const response = await client().post('/v1/accounts', { metadata: { phoneNumber } });
  const result = response.data?.data || response.data;
  return {
    providerWalletId: result.id,
    address: result.address,
    raw: result,
  };
};

const getBalance = async () => {
  throw new Error('Openfort balance adapter is not wired for this project yet.');
};

const sendToken = async () => {
  throw new Error('Openfort transfer adapter is not wired for this project yet.');
};

module.exports = {
  createManagedWallet,
  getBalance,
  sendToken,
};
