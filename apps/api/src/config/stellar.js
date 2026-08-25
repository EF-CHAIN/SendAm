const StellarSdk = require('@stellar/stellar-sdk');
const config = require('./env');
const { attachHorizonResilience } = require('./horizon');

// Ordered list of approved Horizon endpoints. The first entry is the primary;
// the rest are failover endpoints tried in order when the primary is slow or
// unavailable. Reads fail over automatically; writes are sent to a single
// endpoint (never duplicated across failover).
const horizonUrls = [];
if (Array.isArray(config.stellar.horizonUrls) && config.stellar.horizonUrls.length) {
  horizonUrls.push(...config.stellar.horizonUrls);
}
if (config.stellar.horizonUrl) {
  horizonUrls.push(config.stellar.horizonUrl);
}
const baseUrls = [...new Set(horizonUrls.filter(Boolean))];

const timeoutMs = Number(config.stellar.horizonTimeoutMs || 10000);
const circuit = {
  threshold: Number(config.stellar.horizonCircuitThreshold || 3),
  cooldownMs: Number(config.stellar.horizonCircuitCooldownMs || 30000),
};

const primaryUrl = baseUrls[0] || config.stellar.horizonUrl;

const server = new StellarSdk.Horizon.Server(primaryUrl, {
  allowHttp: !!primaryUrl && primaryUrl.startsWith('http://'),
});

// Attach failover + circuit breaking. No-op (single endpoint) when only one
// Horizon URL is configured.
const horizonClient = baseUrls.length
  ? attachHorizonResilience(server.httpClient, { baseUrls, timeoutMs, circuit })
  : { getHealth: () => [], _endpoints: [] };

module.exports = {
  server,
  StellarSdk,
  horizonClient,
  baseUrls,
};
