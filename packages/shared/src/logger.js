/**
 * Minimal frontend logger for error boundary diagnostics.
 *
 * Provides structured console output with sensitive field redaction.
 * Designed to match the observability contract described in docs/OBSERVABILITY.md:
 * correlation IDs, redacted secrets, structured data.
 *
 * Intentionally lightweight — no external SDK dependency.
 *
 * SECURITY INVARIANT: Never log tokens, passwords, cookies, authorization
 * headers, private keys, or full API response bodies.
 */

/** Fields that must always be redacted before logging. Case-insensitive. */
const REDACTED_FIELDS = new Set([
  'password', 'token', 'accesstoken', 'refreshtoken', 'authorization',
  'cookie', 'set-cookie', 'x-auth-token', 'privatekey', 'encryptedkey',
  'secret', 'apikey', 'api_key', 'dsn', 'connectionstring',
]);

const REDACTED_PLACEHOLDER = '[REDACTED]';

/**
 * Recursively redacts sensitive fields from an object for safe logging.
 * Handles nested objects, arrays, and circular references.
 *
 * @param {unknown} value
 * @param {WeakSet} [seen] - used internally to guard circular refs
 * @returns {unknown}
 */
export function redact(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object' && typeof value !== 'function') return value;
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  const result = {};
  for (const [key, val] of Object.entries(value)) {
    if (REDACTED_FIELDS.has(key.toLowerCase())) {
      result[key] = REDACTED_PLACEHOLDER;
    } else if (typeof val === 'object' && val !== null) {
      result[key] = redact(val, seen);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Build a structured log record.
 * @param {'error'|'warn'|'info'} level
 * @param {string} message
 * @param {Object} [context]
 * @returns {Object}
 */
function buildRecord(level, message, context = {}) {
  return {
    level,
    source: 'frontend',
    timestamp: new Date().toISOString(),
    message,
    ...redact(context),
  };
}

/**
 * Log an error boundary catch event.
 * Includes the normalized error's internal diagnostics and the correlation ID.
 * Never includes the raw stack trace or sensitive data.
 *
 * @param {string} message
 * @param {Object} context - safe diagnostic context, already normalized
 */
function error(message, context = {}) {
  // In development, use console.error so the DevTools error overlay still works.
  // In production this still emits a console record; integrate with your
  // error-monitor webhook if you add server-side capture.
  // eslint-disable-next-line no-console
  console.error(buildRecord('error', message, context));
}

/**
 * Log a warning (e.g. malformed data shape).
 */
function warn(message, context = {}) {
  // eslint-disable-next-line no-console
  console.warn(buildRecord('warn', message, context));
}

/**
 * Log informational events (e.g. error boundary reset / retry).
 */
function info(message, context = {}) {
  // eslint-disable-next-line no-console
  console.info(buildRecord('info', message, context));
}

export const logger = { error, warn, info };
