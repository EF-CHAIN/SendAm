// Thin client for the privately-operated sendam-ns naming service. Resolves
// GLOBAL names only — and only sigil-prefixed forms may reach it:
//   @ada             → federation lookup on the configured NS_DOMAIN
//   ada*sendam.app   → federation lookup on the stated domain
// Bare names ("mama") are the user's saved contacts' territory and must
// never be sent here; that precedence lives in whatsapp/recipientResolver.js.
const config = require('../config/env');
const defaultLogger = require('../utils/logger');
const { createServiceClient } = require('./serviceClient');

const createNsClient = ({ nsConfig = config.ns, fetchImpl, logger = defaultLogger } = {}) => {
  const client = createServiceClient({
    name: 'ns',
    baseUrl: nsConfig.serviceUrl,
    secret: nsConfig.secret,
    fetchImpl,
    logger,
  });

  const enabled = Boolean(nsConfig.enabled && client.enabled);
  if (nsConfig.enabled && !client.enabled) {
    logger.warn('ENABLE_NS_RESOLUTION is true but NS_SERVICE_URL/NS_SERVICE_SECRET are unset — global name resolution disabled');
  }

  // "@ada" → "ada*<default domain>"; "ada*x.app" stays as-is; anything else
  // is not a global name.
  const toFederationQuery = (raw) => {
    const value = String(raw || '').trim().toLowerCase();
    if (value.startsWith('@') && value.length > 1 && !value.includes('*')) {
      return `${value.slice(1)}*${nsConfig.domain}`;
    }
    if (/^[a-z0-9][a-z0-9-]*\*[a-z0-9.-]+$/.test(value)) {
      return value;
    }
    return null;
  };

  /**
   * Resolve a sigil-prefixed global name. Returns
   * { accountId, stellarAddress } or null (unknown name, not a global-name
   * form, service off/unreachable).
   */
  const resolveName = async (raw) => {
    const query = toFederationQuery(raw);
    if (!enabled || !query) return null;
    const result = await client.get(`/federation?q=${encodeURIComponent(query)}&type=name`);
    if (!result.ok || !result.data?.account_id) return null;
    return { accountId: result.data.account_id, stellarAddress: result.data.stellar_address };
  };

  return { enabled, resolveName, toFederationQuery };
};

module.exports = {
  createNsClient,
  nsClient: createNsClient(),
};
