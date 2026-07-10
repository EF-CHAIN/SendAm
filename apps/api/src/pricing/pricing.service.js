const axios = require('axios');
const config = require('../config/env');
const prisma = require('../common/prisma');
const { withIdAlias } = require('../common/records');

const getExchangeRate = async ({ sourceCurrency = 'NGN', targetCurrency = 'USDC' }) => {
  if (sourceCurrency === targetCurrency) return 1;

  if (!config.pricing.exchangeRateApiKey) {
    return null;
  }

  const response = await axios.get(`https://v6.exchangerate-api.com/v6/${config.pricing.exchangeRateApiKey}/pair/${sourceCurrency}/${targetCurrency}`, {
    timeout: 15000,
  });
  return response.data?.conversion_rate || null;
};

const createQuote = async ({ userId, sourceCurrency = 'NGN', targetCurrency = 'USDC', sourceAmount, route, provider }) => {
  const rate = await getExchangeRate({ sourceCurrency, targetCurrency });
  const numericAmount = Number(sourceAmount);
  const feeAmount = Number.isFinite(numericAmount) ? numericAmount * 0.01 : 0;
  const targetAmount = rate && Number.isFinite(numericAmount) ? ((numericAmount - feeAmount) * rate).toFixed(6) : undefined;

  const quote = await prisma.quote.create({
    data: {
    userId,
    sourceCurrency,
    targetCurrency,
    sourceAmount: String(sourceAmount),
    targetAmount,
    rate,
    fee: feeAmount.toFixed(2),
    provider,
    route,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    },
  });
  return withIdAlias(quote);
};

module.exports = {
  createQuote,
  getExchangeRate,
};
