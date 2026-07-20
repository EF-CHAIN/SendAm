// Thin client for the privately-operated sendam-settlement service (ledger
// of record, fee-on-top quoting). STUB: behind ENABLE_SETTLEMENT and wired
// into no live flow yet — enabling it changes nothing until a caller
// consults it. It exists so the calling contract is pinned down and wiring
// it in later is a config-plus-callsite change, not a design change.
// Amounts are integer minor-unit strings end to end — never floats.
const config = require('../config/env');
const defaultLogger = require('../utils/logger');
const { createServiceClient } = require('./serviceClient');

const createSettlementClient = ({ settlementConfig = config.settlement, fetchImpl, logger = defaultLogger } = {}) => {
  const client = createServiceClient({
    name: 'settlement',
    baseUrl: settlementConfig.serviceUrl,
    secret: settlementConfig.secret,
    fetchImpl,
    logger,
  });

  const enabled = Boolean(settlementConfig.enabled && client.enabled);
  if (settlementConfig.enabled && !client.enabled) {
    logger.warn('ENABLE_SETTLEMENT is true but SETTLEMENT_SERVICE_URL/SETTLEMENT_SERVICE_SECRET are unset — settlement client disabled');
  }

  const guarded = async (call) => {
    if (!enabled) return null;
    const result = await call();
    return result.ok ? result.data : null;
  };

  return {
    enabled,
    // Mutations carry the caller's idempotency key — the ledger dedups on it.
    credit: ({ userId, chain, asset, amount, idempotencyKey }) =>
      guarded(() => client.post('/credit', { userId, chain, asset, amount }, { idempotencyKey })),
    transfer: ({ fromUserId, toUserId, asset, amount, idempotencyKey }) =>
      guarded(() => client.post('/transfer', { fromUserId, toUserId, asset, amount }, { idempotencyKey })),
    quote: ({ chain, asset, net, targetAsset }) =>
      guarded(() => client.post('/quote', { chain, asset, net, targetAsset })),
    balances: (userId) => guarded(() => client.get(`/balances/${encodeURIComponent(userId)}`)),
  };
};

module.exports = {
  createSettlementClient,
  settlementClient: createSettlementClient(),
};
