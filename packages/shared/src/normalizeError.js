/**
 * Safe error normalization for frontend error boundaries, toasts and alerts.
 *
 * Produces a sanitized representation of any thrown value that is safe to use
 * in user-facing UI. Stack traces, raw backend responses, credentials, tokens,
 * and internal implementation details are kept in the internal diagnostic
 * object and must never be rendered in the UI.
 *
 * Understands Axios errors, fetch failures, thrown `{ status }` objects, the
 * API error envelope, network disconnects and timeouts, and Stellar Horizon
 * transaction/operation result codes.
 *
 * SECURITY INVARIANT:
 *   `normalized.title` / `.message` / `.userMessage` — safe to render in the UI
 *   `normalized.code`                                 — safe, stable identifier
 *   `normalized.internal`                             — for logging only, never render
 */

/** User-facing messages by category. No implementation detail must leak here. */
const USER_MESSAGES = {
  network: 'A network error occurred. Please check your connection and try again.',
  auth: 'Your session has expired. Please log in again.',
  notFound: 'The requested resource was not found.',
  server: 'A server error occurred. Our team has been notified.',
  stellar: 'The Stellar network rejected this transaction. Check the details and try again.',
  unknown: 'Something went wrong. Please try again.',
};

/**
 * @typedef {Object} NormalizedError
 * @property {string} title           - Short heading for a toast or alert
 * @property {string} message         - Actionable, safe message for the UI
 * @property {string} code            - Stable identifier (e.g. `NOT_FOUND`, `TIMEOUT`,
 *                                      or a Stellar code such as `op_underfunded`)
 * @property {string} userMessage     - Alias of `message` (kept for existing callers)
 * @property {'network'|'auth'|'notFound'|'server'|'stellar'|'unknown'} category
 * @property {boolean} retryable      - Whether a user-triggered retry is appropriate
 * @property {string|null} correlationId - Backend correlation ID if available
 * @property {Object} internal        - Diagnostic data; NEVER render to the user
 */

// ---------------------------------------------------------------------------
// Catalogs
// ---------------------------------------------------------------------------

const entry = (category, code, title, message, retryable) =>
  ({ category, code, title, message, retryable });

const NETWORK = entry('network', 'NETWORK_ERROR', 'Connection problem', USER_MESSAGES.network, true);
const OFFLINE = entry('network', 'OFFLINE', 'You are offline',
  'You appear to be offline. Reconnect to the internet and try again.', true);
const TIMEOUT = entry('network', 'TIMEOUT', 'Request timed out',
  'The request took too long to complete. Please try again.', true);
const CANCELED = entry('unknown', 'REQUEST_CANCELED', 'Request cancelled',
  'The request was cancelled before it finished. Please try again.', true);
const UNKNOWN = entry('unknown', 'UNKNOWN_ERROR', 'Something went wrong', USER_MESSAGES.unknown, true);
const AUTH = entry('auth', 'AUTH_REQUIRED', 'Session expired', USER_MESSAGES.auth, false);

/** HTTP status -> entry. Statuses not listed fall back to their class below. */
const HTTP_ERRORS = {
  400: entry('unknown', 'BAD_REQUEST', 'Invalid request',
    'The request could not be processed. Check the details you entered and try again.', false),
  401: AUTH,
  403: entry('auth', 'FORBIDDEN', 'Access denied',
    'You do not have permission to do this. Ask an administrator for access if you need it.', false),
  404: entry('notFound', 'NOT_FOUND', 'Not found', USER_MESSAGES.notFound, false),
  408: TIMEOUT,
  409: entry('unknown', 'CONFLICT', 'Conflict',
    'This item was changed by someone else. Refresh the page and try again.', false),
  422: entry('unknown', 'VALIDATION_FAILED', 'Check your input',
    'Some of the information provided is not valid. Review it and try again.', false),
  429: entry('unknown', 'RATE_LIMITED', 'Too many requests',
    'You are doing that too often. Wait a moment and try again.', true),
  500: entry('server', 'SERVER_ERROR', 'Server error', USER_MESSAGES.server, true),
  502: entry('server', 'SERVICE_UNAVAILABLE', 'Service unavailable',
    'The service is temporarily unavailable. Please try again in a few minutes.', true),
  503: entry('server', 'SERVICE_UNAVAILABLE', 'Service unavailable',
    'The service is temporarily unavailable. Please try again in a few minutes.', true),
  504: entry('server', 'GATEWAY_TIMEOUT', 'Server timed out',
    'The server took too long to respond. Please try again.', true),
};

const CLIENT_ERROR = entry('unknown', 'REQUEST_FAILED', 'Request failed',
  'The request could not be completed. Check the details and try again.', false);
const SERVER_ERROR = HTTP_ERRORS[500];

const stellar = (title, message, retryable) => entry('stellar', null, title, message, retryable);

/** Stellar Horizon transaction and operation result codes. */
const STELLAR_ERRORS = {
  tx_failed: stellar('Transaction failed',
    'The network rejected the transaction. Check the details and try again.', false),
  tx_bad_seq: stellar('Transaction out of sequence',
    'The account changed while this transaction was being sent. Try again.', true),
  tx_insufficient_balance: stellar('Insufficient balance',
    'The account does not have enough XLM to cover the amount, fees and minimum reserve. Add funds or reduce the amount.', false),
  tx_insufficient_fee: stellar('Fee too low',
    'The network fee was too low for current demand. Try again with a higher fee.', true),
  tx_too_late: stellar('Transaction expired',
    'The transaction expired before it was confirmed. Try again.', true),
  tx_too_early: stellar('Transaction not valid yet',
    'The transaction is not valid yet. Wait a moment and try again.', true),
  tx_bad_auth: stellar('Signature rejected',
    'The transaction was not signed correctly. Check the signing account and try again.', false),
  tx_bad_auth_extra: stellar('Signature rejected',
    'The transaction has unneeded signatures. Remove them and try again.', false),
  tx_no_source_account: stellar('Account not found',
    'The sending account does not exist on the network. Fund it before sending.', false),
  tx_internal_error: stellar('Network error',
    'The Stellar network had an internal problem. Try again shortly.', true),
  op_underfunded: stellar('Insufficient funds',
    'The sending account does not have enough of this asset. Reduce the amount or add funds.', false),
  op_no_destination: stellar('Destination not found',
    'The destination account does not exist yet. It must be funded with the minimum XLM balance first.', false),
  op_no_trust: stellar('Missing trustline',
    'The destination account has not added a trustline for this asset.', false),
  op_line_full: stellar('Trustline limit reached',
    'The destination account cannot hold any more of this asset.', false),
  op_not_authorized: stellar('Not authorized',
    'The asset issuer has not authorized the destination account to hold this asset.', false),
  op_src_no_trust: stellar('Missing trustline',
    'The sending account has not added a trustline for this asset.', false),
  op_src_not_authorized: stellar('Not authorized',
    'The asset issuer has not authorized the sending account to hold this asset.', false),
  op_no_issuer: stellar('Asset issuer not found',
    'The issuer of this asset does not exist. Check the asset and try again.', false),
  op_low_reserve: stellar('Reserve too low',
    'The account must keep a minimum XLM reserve. Add XLM and try again.', false),
  op_malformed: stellar('Invalid payment',
    'The payment details are not valid. Check the address and amount.', false),
};

const STELLAR_GENERIC = stellar('Transaction failed', USER_MESSAGES.stellar, false);

const NETWORK_CODES = new Set([
  'ERR_NETWORK', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN',
  'ERR_INTERNET_DISCONNECTED',
]);
const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ERR_TIMEOUT']);
const FETCH_FAILURE = /failed to fetch|networkerror|load failed|network request failed/i;
const SAFE_CODE = /^[a-z0-9_]{1,64}$/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalizes any thrown value into a safe, structured error representation.
 * Never throws.
 *
 * Handles: Error, string, object, null/undefined, non-Error thrown values,
 * Axios/fetch errors with a .response or .status shape, network disconnects,
 * timeouts, cancellations, Stellar Horizon result codes and malformed
 * backend payloads.
 *
 * @param {unknown} thrown - The value caught from a throw or rejection
 * @returns {NormalizedError}
 */
export function normalizeError(thrown) {
  try {
    return normalize(thrown);
  } catch {
    return build(UNKNOWN, { correlationId: null, internal: { thrownType: typeof thrown } });
  }
}

function normalize(thrown) {
  // Capture the correlation ID from an Axios response header if present.
  // This is for internal logging only — do not render it in the UI unless
  // the product explicitly decides to expose reference codes.
  const correlationId = extractCorrelationId(thrown);

  // Stellar Horizon rejected a transaction (usually HTTP 400 with result_codes).
  const stellarCode = extractStellarCode(thrown);
  if (stellarCode) {
    const known = STELLAR_ERRORS[stellarCode] || STELLAR_GENERIC;
    return build({ ...known, code: stellarCode }, {
      correlationId,
      internal: buildInternal(thrown, { status: extractStatus(thrown), stellarCode }),
    });
  }

  // Classify by HTTP status when available (Axios error, fetch-style object).
  const status = extractStatus(thrown);
  if (status !== null) {
    return build(classifyStatus(status), {
      correlationId,
      internal: buildInternal(thrown, { status, backendCode: extractBackendCode(thrown) }),
    });
  }

  // Cancellation, timeout and connectivity failures (no response received).
  const transport = classifyTransport(thrown);
  if (transport) {
    return build(transport, { correlationId, internal: buildInternal(thrown, {}) });
  }

  // Non-Error thrown values (strings, numbers, plain objects, null, undefined).
  if (!(thrown instanceof Error)) {
    return build(UNKNOWN, {
      correlationId: null,
      internal: {
        thrownType: typeof thrown,
        thrownValue: safeStringify(thrown),
      },
    });
  }

  // Generic Error instance — classify by message heuristic.
  const category = classifyErrorMessage(thrown.message);
  const matched = category === 'network' ? NETWORK : category === 'auth' ? AUTH : UNKNOWN;
  return build(matched, { correlationId, internal: buildInternal(thrown, {}) });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function build(matched, { correlationId, internal }) {
  return {
    title: matched.title,
    message: matched.message,
    code: matched.code,
    userMessage: matched.message,
    category: matched.category,
    retryable: matched.retryable,
    correlationId,
    internal,
  };
}

function extractStatus(thrown) {
  const raw = thrown?.response?.status ?? thrown?.status ?? thrown?.statusCode;
  const status = typeof raw === 'string' ? Number(raw) : raw;
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function classifyStatus(status) {
  if (HTTP_ERRORS[status]) return HTTP_ERRORS[status];
  if (status >= 500) return SERVER_ERROR;
  if (status >= 400) return CLIENT_ERROR;
  return UNKNOWN;
}

function classifyTransport(thrown) {
  const code = thrown?.code;
  const name = thrown?.name;
  if (code === 'ERR_CANCELED' || name === 'AbortError' || name === 'CanceledError') return CANCELED;
  if (TIMEOUT_CODES.has(code) || name === 'TimeoutError') return TIMEOUT;
  if (NETWORK_CODES.has(code) || thrown?.message === 'Network Error' ||
      (thrown instanceof TypeError && FETCH_FAILURE.test(thrown.message))) {
    return typeof navigator !== 'undefined' && navigator.onLine === false ? OFFLINE : NETWORK;
  }
  return null;
}

function classifyErrorMessage(message = '') {
  const lower = String(message).toLowerCase();
  if (lower.includes('network') || lower.includes('fetch')) return 'network';
  if (lower.includes('unauthorized') || lower.includes('forbidden') ||
      lower.includes('auth')) return 'auth';
  return 'unknown';
}

/**
 * Pull the most specific Stellar result code from a Horizon error. Operation
 * codes win over the generic `tx_failed`. Only well-formed codes are returned.
 */
function extractStellarCode(thrown) {
  const codes =
    thrown?.response?.data?.extras?.result_codes ??
    thrown?.data?.extras?.result_codes ??
    thrown?.extras?.result_codes;
  if (!codes || typeof codes !== 'object') return null;

  const operations = Array.isArray(codes.operations) ? codes.operations : [];
  const candidates = [
    ...operations.filter((c) => c !== 'op_success'),
    codes.transaction,
  ];
  const found = candidates.find((c) => typeof c === 'string' && c !== 'tx_success' && SAFE_CODE.test(c));
  return found || null;
}

/** The API envelope's error.code, for internal logging only. */
function extractBackendCode(thrown) {
  const code = thrown?.response?.data?.error?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : undefined;
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
  const internal = {};
  for (const [key, value] of Object.entries(extra)) {
    if (value !== null && value !== undefined) internal[key] = value;
  }

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
