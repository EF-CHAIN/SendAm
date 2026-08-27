// Horizon resilience: an ordered list of approved endpoints with bounded
// timeouts, per-endpoint health tracking, and circuit breaking.
//
// A slow or unavailable Horizon endpoint must not block wallet/payment
// operations. Reads (GET) fail over across the ordered endpoint list; writes
// (POST, e.g. transaction submission) are sent to exactly ONE endpoint so a
// retry can never duplicate a submission — if a write fails ambiguously
// (timeout/connection loss) we surface a clear "uncertain" error instead of
// resubmitting to another host.
//
// Integration point: `attachHorizonResilience(server.httpClient, opts)` registers
// axios interceptors on the Stellar SDK's HTTP client, so EVERY SDK call
// (loadAccount, fetchBaseFee, submitTransaction, and builder reads like
// transactions().transactionHash().call()) inherits this behavior without any
// change to call sites. The signed transaction (and thus its network passphrase)
// is never altered — only the request host is rewritten — so passphrase
// validation is preserved across failover.

class HorizonTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HorizonTimeoutError';
    this.isHorizonTimeout = true;
  }
}

class HorizonOutageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HorizonOutageError';
  }
}

// Thrown when a write could not be confirmed. The transaction was sent to a
// single endpoint and NOT resubmitted elsewhere, so the caller can verify
// (e.g. by hashing the built transaction and querying it) rather than blindly
// retrying and risking a double spend.
class HorizonWriteUncertainError extends Error {
  constructor(message, hash) {
    super(message);
    this.name = 'HorizonWriteUncertainError';
    this.isHorizonWriteUncertain = true;
    this.hash = hash;
  }
}

const isHorizonWriteUncertain = (error) => !!(error && error.isHorizonWriteUncertain);

const safeHost = (url) => {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

const rewriteOrigin = (url, baseUrl) => {
  const u = new URL(url);
  const b = new URL(baseUrl);
  u.protocol = b.protocol;
  u.host = b.host;
  u.hostname = b.hostname;
  u.port = b.port;
  return u.toString();
};

// A failed read (no HTTP response, or an axios timeout) is ambiguous and we
// fail over. A definitive HTTP error (e.g. 400/409) is NOT ambiguous — surfaced
// as-is so callers keep their existing error handling. For writes, ANY
// ambiguous failure is reported as "uncertain" (never resubmitted).
const isAmbiguous = (err) => !!(err && (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || !err.response));

const isWriteMethod = (config) => {
  const method = (config.method || 'get').toLowerCase();
  return method === 'post' || method === 'put' || method === 'delete';
};

/**
 * Attach failover + circuit-breaking to an axios-compatible HTTP client
 * (the Stellar SDK's `server.httpClient`). Returns a handle with `getHealth()`.
 *
 * @param {object} httpClient - axios instance (must support
 *   `interceptors.response.use` and `request(config)`).
 * @param {object} opts
 * @param {string[]} opts.baseUrls - ordered list of approved Horizon endpoints.
 * @param {number} [opts.timeoutMs=10000] - per-request timeout (bounded).
 * @param {object} [opts.circuit] - { threshold, cooldownMs }.
 * @param {function} [opts.now] - injectable clock for testing.
 */
const attachHorizonResilience = (httpClient, { baseUrls = [], timeoutMs = 10000, circuit = {}, now = Date.now } = {}) => {
  if (!httpClient || !httpClient.interceptors) {
    return httpClient || { getHealth: () => [], _endpoints: [] };
  }
  const threshold = circuit.threshold ?? 3;
  const cooldownMs = circuit.cooldownMs ?? 30000;

  const endpoints = baseUrls.map((url, index) => ({
    url,
    index,
    consecutiveFailures: 0,
    open: false,
    openedAt: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
  }));
  const byUrl = new Map(endpoints.map((e) => [e.url, e]));

  const isOpen = (ep) => ep.open && (now() - ep.openedAt) < cooldownMs;
  const available = () => endpoints.filter((e) => !isOpen(e));
  const recordSuccess = (ep) => {
    if (!ep) return;
    ep.consecutiveFailures = 0;
    ep.open = false;
    ep.lastSuccessAt = now();
  };
  const recordFailure = (ep) => {
    if (!ep) return;
    ep.consecutiveFailures += 1;
    ep.lastFailureAt = now();
    if (ep.consecutiveFailures >= threshold) {
      ep.open = true;
      ep.openedAt = now();
    }
  };

  if (!httpClient || !httpClient.interceptors) {
    return { getHealth: () => [], _endpoints: [] };
  }

  httpClient.interceptors.request.use((config) => {
    if (config.__horizonRetrying) return config;
    const hosts = available();
    if (hosts.length === 0) {
      throw new HorizonOutageError('All Horizon endpoints are unavailable (circuit open).');
    }
    // Remember the chosen ordered candidate list so the response-interceptor
    // failover continues from the NEXT endpoint (no duplicate attempts).
    config.__candidates = hosts;
    config.url = rewriteOrigin(config.url, hosts[0].url);
    config.timeout = timeoutMs;
    return config;
  });

  // Core retry/failover loop. For reads it walks the available endpoints; for
  // writes it attempts exactly one endpoint (no duplicate submission).
  const tryRequest = (config, candidates, attempt) => {
    if (attempt >= candidates.length) {
      if (available().length === 0) {
        return Promise.reject(new HorizonOutageError('All Horizon endpoints are unavailable (circuit open).'));
      }
      return Promise.reject(
        config.__lastError || new HorizonOutageError('All Horizon endpoints are unavailable (circuit open).'),
      );
    }
    const ep = candidates[attempt];
    const newConfig = {
      ...config,
      url: rewriteOrigin(config.url, ep.url),
      __horizonRetrying: true,
      __attempt: attempt + 1,
      timeout: timeoutMs,
    };

    return Promise.resolve(httpClient.request(newConfig)).then(
      (res) => {
        recordSuccess(ep);
        return res;
      },
      (err) => {
        recordFailure(ep);
        if (isWriteMethod(config)) {
          if (isAmbiguous(err)) {
            return Promise.reject(
              new HorizonWriteUncertainError('Transaction submission status unknown after timeout/loss; not resubmitting to avoid duplicate.'),
            );
          }
          return Promise.reject(err);
        }
        config.__lastError = err;
        return tryRequest(config, candidates, attempt + 1);
      },
    );
  };

  httpClient.interceptors.response.use(
    (response) => {
      const host = safeHost(response.config?.url);
      if (host) recordSuccess(byUrl.get(host));
      return response;
    },
    (error) => {
      const config = error.config || {};
      // Requests we already re-dispatched must not be re-orchestrated.
      if (config.__horizonRetrying) return Promise.reject(error);
      if (!baseUrls.length) return Promise.reject(error);

      // Writes are sent exactly once. The original request already hit the
      // network, so we must never resubmit (a retry to any endpoint — even the
      // same one — could duplicate the transaction). On an ambiguous failure
      // (timeout/connection loss) we report "uncertain" and let the caller
      // verify by hash; on a definitive error we surface it as-is.
      if (isWriteMethod(config)) {
        if (isAmbiguous(error)) {
          return Promise.reject(
            new HorizonWriteUncertainError('Transaction submission status unknown after timeout/loss; not resubmitting to avoid duplicate.'),
          );
        }
        return Promise.reject(error);
      }

      // The request interceptor already attempted candidates[0]; record its
      // failure (so circuit-breaking still kicks in) and continue from the next
      // endpoint. If it never ran, fall back to a fresh candidate list.
      const candidates = config.__candidates && config.__candidates.length
        ? config.__candidates
        : available();
      recordFailure(candidates[0]);
      const start = config.__candidates ? 1 : 0;
      return tryRequest({ ...config }, candidates, start);
    },
  );

  const getHealth = () => endpoints.map((e) => ({
    url: e.url,
    index: e.index,
    open: e.open,
    consecutiveFailures: e.consecutiveFailures,
    lastSuccessAt: e.lastSuccessAt,
    lastFailureAt: e.lastFailureAt,
  }));

  return { getHealth, _endpoints: endpoints };
};

module.exports = {
  attachHorizonResilience,
  isHorizonWriteUncertain,
  HorizonTimeoutError,
  HorizonOutageError,
  HorizonWriteUncertainError,
};
