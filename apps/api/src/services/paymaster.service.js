// Thin client for a privately-operated gas-sponsorship relayer. The relayer
// itself (a funded Lisk gas wallet, meta-transaction signing) is not part of
// this repo — see ARCHITECTURE.md for why. This module is the complete,
// real calling contract: whenever a relayer exists at PAYMASTER_SERVICE_URL,
// wiring it in is a config change, not a code change.
//
// Not yet called from the live send flow — lisk.adapter.js's submitPayment
// signs and pays gas from the user's own wallet, and there is no
// meta-transaction submission path built yet for a sponsored transaction to
// flow through. That's a separate, larger piece of work. This client is
// ready for it, not a stand-in for it.
const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');

const REQUEST_TIMEOUT_MS = 10000;

/**
 * Ask the configured paymaster to sponsor a Lisk transaction's gas. Never
 * throws — an unconfigured or unreachable paymaster degrades to
 * { sponsored: false, reason }, the same pattern used elsewhere (e.g.
 * whatsapp.service.js, priceOracle.service.js) so a missing external
 * service never breaks the feature that depends on it.
 */
const sponsorTransaction = async ({ from, to, amount, chain }) => {
  if (!config.paymaster.serviceUrl) {
    return { sponsored: false, reason: 'Paymaster not configured' };
  }

  try {
    const response = await axios.post(
      `${config.paymaster.serviceUrl}/sponsor`,
      { from, to, amount, chain },
      {
        headers: { Authorization: `Bearer ${config.paymaster.apiKey}` },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );
    return { sponsored: true, txHash: response.data.txHash };
  } catch (error) {
    logger.error('Paymaster service unreachable or errored', error.message);
    return { sponsored: false, reason: 'Paymaster unreachable' };
  }
};

module.exports = {
  sponsorTransaction,
};
