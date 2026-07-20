// Shared thin-client helper for SendAm's privately-operated services
// (sendam-ai, sendam-settlement, sendam-paymaster, sendam-ns). One place for
// the calling contract every private service speaks:
//
//   X-Sendam-Signature: hex HMAC-SHA256 of the raw request body
//   X-Sendam-Timestamp: unix seconds (services accept ±5 minutes)
//   Idempotency-Key:    optional, persisted per mutating route
//
// Clients built from this NEVER throw — an unconfigured or unreachable
// service degrades to { ok: false, reason } so a missing private service
// never breaks the public feature that consults it (the pattern
// paymaster.service.js established).
const crypto = require('node:crypto');
const defaultLogger = require('../utils/logger');

const createServiceClient = ({
  name,
  baseUrl,
  secret,
  timeoutMs = 10000,
  fetchImpl,
  logger = defaultLogger,
}) => {
  const enabled = Boolean(baseUrl && secret);
  const trimmedBase = enabled ? baseUrl.replace(/\/+$/, '') : baseUrl;

  const request = async (method, path, body, { idempotencyKey } = {}) => {
    if (!enabled) {
      return { ok: false, reason: `${name} service not configured` };
    }

    // Sign the exact string that goes on the wire — never re-serialize.
    const rawBody = body === undefined ? '' : JSON.stringify(body);
    const headers = {
      'X-Sendam-Signature': crypto.createHmac('sha256', secret).update(rawBody).digest('hex'),
      'X-Sendam-Timestamp': String(Math.floor(Date.now() / 1000)),
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    try {
      const doFetch = fetchImpl || fetch;
      const response = await doFetch(`${trimmedBase}${path}`, {
        method,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        ...(body === undefined ? {} : { body: rawBody }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        logger.warn(`${name} service responded ${response.status}${data?.code ? ` (${data.code})` : ''}`);
        return { ok: false, reason: `${name} service error`, status: response.status, data };
      }
      return { ok: true, data };
    } catch (error) {
      logger.warn(`${name} service unreachable: ${error.message}`);
      return { ok: false, reason: `${name} service unreachable` };
    }
  };

  return {
    enabled,
    post: (path, body, options = {}) => request('POST', path, body ?? {}, options),
    get: (path) => request('GET', path, undefined),
  };
};

module.exports = { createServiceClient };
