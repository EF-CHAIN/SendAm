// Formats a balance/amount with an approximate naira estimate alongside it,
// e.g. "20 USDC (~₦31,000)". Pure formatting only — priceOracle.service.js
// is the one that talks to the network; this module just renders whatever
// rate (or null) it was handed.

/**
 * @param {number} amount
 * @param {string} asset - 'USDC' | 'XLM'
 * @param {number|null} rate - NGN-per-USD rate (see priceOracle.service.js:getUsdToNgnRate), or null if unavailable
 * @returns {string}
 */
const formatWithNgn = (amount, asset, rate) => {
  const base = `${amount} ${asset}`;

  // XLM has no USD feed at MVP; USDC is treated 1:1 with USD so `rate` (an
  // NGN-per-USD rate) applies to it directly.
  if (asset === 'XLM' || rate == null) {
    return base;
  }

  const naira = Math.round(amount * rate);
  return `${base} (~₦${naira.toLocaleString('en-US')})`;
};

module.exports = {
  formatWithNgn,
};
