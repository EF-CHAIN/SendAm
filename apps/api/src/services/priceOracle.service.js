// NGN display rate for showing balances in Naira alongside the native
// asset. The provider is swappable on purpose: whether SendAm should show
// the official CBN rate or a parallel-market rate is a product decision,
// not one this file makes — see MAINTAINER.md.
//
// Default provider (open.er-api.com) is a free, no-API-key-required
// endpoint — verified live: https://open.er-api.com/v6/latest/USD returns a
// real, current USD/NGN rate. Swap FX_PROVIDER to add a CBN-official-rate
// provider (or any other source) without touching callers.
const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');

const REQUEST_TIMEOUT_MS = 10000;

const providers = {
  exchangerate_api: async () => {
    const response = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: REQUEST_TIMEOUT_MS });
    const rate = response.data?.rates?.NGN;
    if (!rate) {
      throw new Error('NGN rate missing from exchangerate_api response');
    }
    return { rate, source: 'open.er-api.com (market rate)' };
  },
  // Add a CBN-official-rate provider here if/when that product decision is
  // made — same { rate, source } shape, swap FX_PROVIDER to activate it.
};

/**
 * Returns the current NGN-per-USD rate, or null (never throws) if the
 * configured provider is unavailable — a display feature failing should
 * never break the balance check it's attached to.
 */
const getUsdToNgnRate = async () => {
  const provider = providers[config.fx.provider];
  if (!provider) {
    logger.error(`Unknown FX_PROVIDER "${config.fx.provider}"`);
    return null;
  }
  try {
    return await provider();
  } catch (error) {
    logger.error('Price oracle fetch failed', error.message);
    return null;
  }
};

module.exports = {
  getUsdToNgnRate,
};
