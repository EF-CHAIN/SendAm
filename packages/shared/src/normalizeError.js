/**
 * Safe error normalization for frontend error boundaries.
 *
 * Produces a sanitized representation of any thrown value that is safe to use
 * in user-facing UI. Stack traces, raw backend responses, credentials, tokens,
 * and internal implementation details are kept in the internal diagnostic
 * object and must never be rendered in the UI.
 *
 * SECURITY INVARIANT:
 *   `normalized.userMessage`  — safe to render in the UI
 *   `normalized.internal`     — for logging only, never render to the user
 */

/** User-facing messages by category. No implementation detail must leak here. */
const USER_MESSAGES = {
  network: 'A network error occurred. Please check your connection and try again.',
  auth: 'Your session has expired. Please log in again.',
  notFound: 'The requested resource was not found.',
  server: 'A server error occurred. Our team has been notified.',
  unknown: 'Something went wrong. Please try again.',
};

/**
 * @typedef {Object} NormalizedError
 * @property {string} userMessage     - Safe message for the UI
 * @property {'network'|'auth'|'notFound'|'server'|'unknown'} category
 * @property {boolean} retryable      - Whether a user-triggered retry is appropriate
 * @property {string|null} correlationId - Backend correlation ID if available
 * @property {Object} internal        - Diagnostic data; NEVER render to the user
 */

/**
 * Normalizes any thrown value into a safe, structured error representation.
 *
 * Handles: Error, string, object, null/undefined, non-Error thrown values,
 * Axios/fetch errors with a .response shape, and malformed backend payloads.
 *
 * @param {unknown} thrown - The value caught from a throw or rejection
 * @returns {NormalizedError}
 */
export function normalizeError(thrown) {
  // Capture the correlation ID from an Axios response header if present.
  // This is for internal logging only — do not render it in the UI unless
  // the product explicitly decides to expose reference codes.
  const correlationId = extractCorrelationId(thrown);

  // Classify by HTTP status when available (Axios error shape).
  const status = thrown?.response?.status ?? thrown?.status ?? null;
  if (status !== null) {
    const category = classifyStatus(status);
    return {
      userMessage: USER_MESSAGES[category],
      category,
      retryable: category !== 'auth',
      correlationId,
      internal: buildInternal(thrown, { status }),
    };
  }

  // Network / connectivity failure (Axios sets code, no response).
  if (thrown?.code === 'ERR_NETWORK' || thrown?.code === 'ECONNREFUSED' ||
      thrown?.message === 'Network Error') {
    return {
      userMessage: USER_MESSAGES.network,
      category: 'network',
      retryable: true,
      correlationId,
      internal: buildInternal(thrown, {}),
    };
  }

  // Non-Error thrown values (strings, numbers, plain objects, null, undefined).
  if (!(thrown instanceof Error)) {
    return {
      userMessage: USER_MESSAGES.unknown,
      category: 'unknown',
      retryable: true,
      correlationId: null,
      internal: {
        thrownType: typeof thrown,
        thrownValue: safeStringify(thrown),
      },
    };
  }

  // Generic Error instance — classify by message heuristic.
  const category = classifyErrorMessage(thrown.message);
  return {
    userMessage: USER_MESSAGES[category],
    category,
    retryable: category !== 'auth',
    correlationId,
    internal: buildInternal(thrown, {}),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function classifyStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'notFound';
  if (status >= 500) return 'server';
  if (!status || status >= 400) return 'unknown';
  return 'unknown';
}

function classifyErrorMessage(message = '') {
  const lower = message.toLowerCase();
  if (lower.includes('network') || lower.includes('fetch')) return 'network';
  if (lower.includes('unauthorized') || lower.includes('forbidden') ||
      lower.includes('auth')) return 'auth';
  return 'unknown';
}

/**
 * Safely extract the x-correlation-id header from an Axios error response.
 * Only reads a safe, bounded header value; does not access tokens or auth data.
 */
function extractCorrelationId(thrown) {
  try {
    // Axios error: thrown.response.headers['x-correlation-id']
    const id = thrown?.response?.headers?.['x-correlation-id'];
    if (typeof id === 'string' && id.length > 0 && id.length <= 128) {
      return id;
    }
  } catch {
    // Ignore — never crash in error-handling code
  }
  return null;
}

/**
 * Build safe internal diagnostics. Captures error category and original
 * message (for logging) but excludes full stack in production to reduce
 * accidental log leakage of file paths, and never includes auth headers,
 * request bodies, or sensitive response payloads.
 */
function buildInternal(thrown, extra) {
  const internal = { ...extra };

  if (thrown instanceof Error) {
    internal.name = thrown.name;
    // Keep a one-line summary without the full stack (which contains file paths).
    // The boundary's componentDidCatch receives the full stack separately for
    // console logging under dev environments.
    internal.message = thrown.message;
  }

  // HTTP status and a sanitized subset of the Axios response.
  if (thrown?.response) {
    internal.status = thrown.response.status;
    // Never include response data — it may contain sensitive backend payloads.
    // Only log the URL path (not the full URL which might embed query tokens).
    const url = thrown.response.config?.url;
    if (typeof url === 'string') {
      // Strip query string to avoid logging API keys in query params.
      internal.path = url.split('?')[0];
    }
  }

  return internal;
}

/**
 * Safely stringify any value to a short string for internal diagnostics.
 * Caps length to prevent enormous log entries.
 */
function safeStringify(value) {
  try {
    const str = JSON.stringify(value);
    return typeof str === 'string' ? str.slice(0, 200) : String(value).slice(0, 200);
  } catch {
    return '[unserializable]';
  }
}
