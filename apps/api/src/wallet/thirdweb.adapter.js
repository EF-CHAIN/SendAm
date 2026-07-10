const axios = require('axios');
const config = require('../config/env');

const configured = () => Boolean(config.thirdweb.engineUrl && config.thirdweb.accessToken);

const client = () => {
  if (!configured()) {
    throw new Error('Thirdweb Engine is not configured. Set THIRDWEB_ENGINE_URL and THIRDWEB_ACCESS_TOKEN.');
  }
  return axios.create({
    baseURL: config.thirdweb.engineUrl.replace(/\/$/, ''),
    headers: {
      Authorization: `Bearer ${config.thirdweb.accessToken}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });
};

const createManagedWallet = async ({ label, type = 'smart:local' }) => {
  const response = await client().post('/backend-wallet/create', { type, label });
  const result = response.data?.result || response.data;
  return {
    providerWalletId: result.id || result.address || label,
    address: result.address || result.walletAddress,
    raw: result,
  };
};

const getBalance = async ({ chain, address }) => {
  const response = await client().get(`/backend-wallet/${encodeURIComponent(chain)}/${encodeURIComponent(address)}/get-balance`);
  return response.data?.result || response.data;
};

const sendToken = async ({ chain, fromAddress, tokenAddress, destination, amount }) => {
  if (!tokenAddress) {
    throw new Error('Token contract address is required for Thirdweb token transfers.');
  }

  const response = await client().post(
    `/contract/${encodeURIComponent(chain)}/${encodeURIComponent(tokenAddress)}/write`,
    {
      functionName: 'transfer',
      args: [destination, amount.toString()],
    },
    {
      headers: {
        'x-backend-wallet-address': fromAddress || config.thirdweb.backendWalletAddress,
      },
    }
  );

  return response.data?.result || response.data;
};

module.exports = {
  createManagedWallet,
  getBalance,
  sendToken,
};
