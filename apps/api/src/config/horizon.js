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

// Thrown when a write could not be confirmed. The transaction was sent to a single endpoint and NOT resubmitted elsewhere, so the caller can verify
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

// NEW: Thrown when a request body or response exceeds the configured limit.
class HorizonLoadTooLargeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HorizonPayloadTooLargeError';
    this.isPayloadTooLarge = true;
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
// fail over. A definitive HTTP error (e.g. 400/409) is NOT ambiguous - surfaced
// as-is so callers keep their existing error handling. For writes, ANY ambiguous
// failure is reported as "uncertain" (never resubmitted).
const isAmbiguous = (err) => !!(err && (err.code === 'ECONNABOLTED' || err.code === 'ETIMEDOUT' || !err.response));

const isWriteMethod = (config) => {
  const method = (config.method || 'get').toLowerCase();
  return method === 'post' || method === 'put' || method === 'delete';
};

const isPayloadTooLarge = (err) => !!(err && (err.code === 'ERR_BODY_LENGTH_LIMIT' || err.code === 'ERR_CONTENT_LENGTH_LIMIT' || err.isPayloadTooLarge));

/**
 * Attach failover + circuit-breaking to an axios-compatible HTTP client
 * (the Stellar SDK's `server.httpClient`). Returns a handle with `getHealth`.
 *
 * @param {object} httpClient - axios instance (must support
 *  `interceptors.response.use` and `request(config)`).
 * @param {object} opts
 * @param string[] opts.baseUrls - ordered list of approved Horizon endpoints.
 * @param {number} [opts.timeoutMs] - per-request timeout (bounded).
 * @param {number} [opts.totalTimeoutMs]=30000] - maximum total time for the entire operation including failover attempts.
 * @param {number} [opts.maxBodyLength] - default maximum request body size in bytes.
 * @param {number} [opts.maxContentLength] - default maximum response size in bytes.
 * @param {object} [opts.routeLimits] - pattern to {@link {maxBodyLength, maxContentLength}} for route-specific limits.
 * @param {object} [opts.circuit] - { threshold, cooldownMs }.
 * @param {function} [opts.now] - injectable clock for testing.
 */
const attachHorizonResilience = (httpClient, {
  baseUrls = [],
  timeoutMs = 10000,
  totalTimeoutMs = 30000,
  maxBodyLength,
  maxContentLength,
  routeLimits = {},
  circuit = {},
  now = Date.now,
} = {}) => {
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

  // Default route-specific body/limit configuration for common Horizon endpoints.
  const defaultRouteLimits = {
    '/transactions': { maxBodyLength: 1024 * 1024 * 2 }, // 2 MB for transaction submission (XDR can be large)
    '/accounts/': { maxContentLength: 1024 * 1024 * 1 }, // 1 MB for account responses
    '/payments': { maxContentLength: 1024 * 1024 * 1 },
    '/effects': { maxContentLength: 1024 * 1024 * 1 },
    '/operations': { maxContentLength: 1024 * 1024 * 1 },
    '/trades': { maxContentLength: 1024 * 1024 * 1 },
  };
  const effectiveRouteLimits = { ...defaultRouteLimits, ...routeLimits };

  // Pre-compile route matchers for performance.
  const routeLimitEntries = Object.entries(effectiveRouteLimits).map(([pattern, limit]) => {
    if (pattern.startsWith('/')) {
      return { test: (path) => path.startsWith(pattern), limit };
    }
    return { test: (path) => new RegExp(pattern).test(path), limit };
  });

  const getRouteLimit = (url) => {
    let path;
    try { path = new URL(url).pathname; } catch { return undefined; }
    for (const entry of routeLimitEntries) {
      if (entry.test(path)) return entry.limit;
    }
    return undefined;
  };

  // Metrics for limit breaches and timeouts.
  const metrics = {
    totalRequests: 0,
    timeouts: 0,
    payloadTooLarge: 0,
    writeUncertain: 0,
  };

  if (!httpClient || !httpClient.interceptors) {
    return { getHealth: () => [], _endpoints: [] };
  }

  // Rewrite the outgoing request to the first healthy endpoint *before* it hits
  // the wire, so a known-open (circuit-broken) endpoint is never even contacted.
  // This also gives us a single, fast fail when every endpoint is open.
  httpClient.interceptors.request.use((config) => {
    metrics.totalRequests += 1;
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
    config.__startTime = config.__startTime || now();

    const limit = getRouteLimit(config.url);
    if (limit) {
      if (limit.maxBodyLength !== undefined) config.maxBodyLength = limit.maxBodyLength;
      if (limit.maxContentLength !== undefined) config.maxContentLength = limit.maxContentLength;
    } else {
      if (maxBodyLength !== undefined) config.maxBodyLength = maxBodyLength;
      if (maxContentLength !== undefined) config.maxContentLength = maxContentLength;
    }
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
    if (totalTimeoutMs && (now() - (config.__startTime || now()) > totalTimeoutMs)) {
      metrics.timeouts += 1;
      return Promise.reject(
        config.__lastError || new HorizonTimeoutError('Horizon request timed out after total execution limit.'),
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
        if (isPayloadTooLarge(err)) {
          metrics.payloadTooLarge += 1;
          return Promise.reject(
            err instanceof HorizonLoadTooLargeError ? err : new HorizonLoadTooLargeError('Horizon request payload too large.'),
          );
        }
        if (err && err.code === 'ECONNABOLTED') metrics.timeouts += 1;
        if (isWriteMethod(config)) {
          if (isAmbiguous(err)) {
            metrics.writeUncertain += 1;
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

      // Check for total execution timeout before handling other failures.
      if (totalTimeoutMs && (now() - (config.__startTime || now()) > totalTimeoutMs)) {
        metrics.timeouts += 1;
        return Promise.reject(config.__lastError || new HorizonTimeoutError('Horizon request timed out after total execution limit.'));
      }

      // Surface safe errors for body/response limit breaches instead of failover.
      if (isPayloadTooLarge(error)) {
        metrics.payloadTooLarge += 1;
        return Promise.reject(
          error instanceof HorizonLoadTooLargeError ? error : new HorizonLoadTooLargeError('Horizon request payload too large.'),
        );
      }

      // Writes are sent exactly once. The original request already hit the
      // network, so we must never resubmit (a retry to any endpoint -- even the
      // same one -- could duplicate the transaction). On an ambiguous failure
      // (timeout/connection loss) we report "uncertain" and let the caller
      // verify by hash; on a definitive error we surface it as-is.
      if (isWriteMethod(config)) {
        if (isAmbiguous(error)) {
          metrics.writeUncertain += 1;
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

  const getMetrics = () => ({ ...metrics });

  return { getHealth, getMetrics, _endpoints: endpoints };
};

module.exports = {
  attachHorizonResilience,
  isHorizonWriteUncertain,
  HorizonTimeoutError,
  HorizonOutageError,
  HorizonWriteUncertainError,
  HorizonLoadTooLargeError,
};