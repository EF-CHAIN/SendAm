// Thin client for a privately-operated fee-sponsorship relayer. The relayer
// itself (a funded sponsor wallet building Stellar fee-bump / sponsored-
// reserve envelopes) is not part of this repo — see ARCHITECTURE.md for why.
// This module is the complete, real calling contract: whenever a relayer
// exists at PAYMASTER_SERVICE_URL, wiring it in is a config change, not a
// code change.
//
// Auth is the shared X-Sendam-Signature HMAC contract (serviceClient.js),
// keyed with PAYMASTER_SERVICE_SECRET; the old PAYMASTER_API_KEY bearer
// token is deprecated. Both URL and secret must be set — anything less is
// "not configured" and degrades exactly as before.
//
// Not yet called from the live send flow — stellar.adapter.js's
// submitPayment signs and pays the network fee from the user's own wallet,
// and there is no fee-bump submission path built yet for a sponsored
// transaction to flow through. That's a separate, larger piece of work.
// This client is ready for it, not a stand-in for it.
const config = require('../config/env');
const defaultLogger = require('../utils/logger');
const { createServiceClient } = require('./serviceClient');

/**
 * Ask the configured paymaster to sponsor a transaction's network fee. Never
 * throws — an unconfigured or unreachable paymaster degrades to
 * { sponsored: false, reason }, the same pattern used elsewhere (e.g.
 * whatsapp.service.js, priceOracle.service.js) so a missing external
 * service never breaks the feature that depends on it.
 */
const createPaymasterClient = ({ paymasterConfig = config.paymaster, fetchImpl, logger = defaultLogger } = {}) => {
  const client = createServiceClient({
    name: 'paymaster',
    baseUrl: paymasterConfig.serviceUrl,
    secret: paymasterConfig.secret,
    fetchImpl,
    logger,
  });

  const sponsorTransaction = async ({ from, to, amount, chain }) => {
    if (!client.enabled) {
      return { sponsored: false, reason: 'Paymaster not configured' };
    }
    const result = await client.post('/sponsor', { from, to, amount, chain });
    if (!result.ok) {
      return { sponsored: false, reason: 'Paymaster unreachable' };
    }
    return { sponsored: true, txHash: result.data?.txHash };
  };

  return { enabled: client.enabled, sponsorTransaction };
};

const defaultClient = createPaymasterClient();

module.exports = {
  createPaymasterClient,
  sponsorTransaction: defaultClient.sponsorTransaction,
};
