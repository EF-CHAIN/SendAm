// Thin client for a privately-operated transaction-policy service. When it
// answers, its verdict is authoritative; when it is off or unreachable the
// caller falls back to the local KYC-tier logic in compliance.service.js —
// the documented, deliberately-naive local fallback.
//
// Note: which service ultimately owns policy (settlement vs a dedicated
// policy engine) is an open decision — this client speaks POST /policy/check
// against whatever host POLICY_SERVICE_URL names. See SPLIT-REPORT.
const config = require('../config/env');
const defaultLogger = require('../utils/logger');
const { createServiceClient } = require('./serviceClient');

const createPolicyClient = ({ policyConfig = config.policy, fetchImpl, logger = defaultLogger } = {}) => {
  const client = createServiceClient({
    name: 'policy',
    baseUrl: policyConfig.serviceUrl,
    secret: policyConfig.secret,
    fetchImpl,
    logger,
  });

  const enabled = Boolean(policyConfig.enabled && client.enabled);
  if (policyConfig.enabled && !client.enabled) {
    logger.warn('ENABLE_POLICY_SERVICE is true but POLICY_SERVICE_URL/POLICY_SERVICE_SECRET are unset — using local policy only');
  }

  /**
   * Ask the policy service to vet a transaction. Returns
   *   { allowed, reason?, riskScore? }  when the service answered, or
   *   null                              when it is off/unreachable —
   * null tells the caller to run the local fallback instead.
   */
  const checkPolicy = async ({ userId, amount, routeType, destinationCountry }) => {
    if (!enabled) return null;
    const result = await client.post('/policy/check', { userId, amount: String(amount), routeType, destinationCountry });
    if (!result.ok || !result.data || typeof result.data.allowed !== 'boolean') return null;
    return {
      allowed: result.data.allowed,
      reason: result.data.reason,
      riskScore: typeof result.data.riskScore === 'number' ? result.data.riskScore : 0,
    };
  };

  return { enabled, checkPolicy };
};

module.exports = {
  createPolicyClient,
  policyClient: createPolicyClient(),
};
