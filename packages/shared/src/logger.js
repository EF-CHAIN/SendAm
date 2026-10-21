/**
 * Minimal frontend logger for error boundary diagnostics.
 *
 * Provides structured console output with sensitive field redaction.
 * Designed to match the observability contract described in docs/OBSERVABILITY.md:
 * correlation IDs, redacted secrets, structured data.
 *
 * Every record is also kept in a fixed-size in-memory ring buffer (the last
 * LOG_BUFFER_SIZE entries) so support can export recent activity after the
 * console has been cleared or the page has navigated within the SPA.
 *
 * Intentionally lightweight — no external SDK dependency.
 *
 * SECURITY INVARIANT: Never log tokens, passwords, cookies, authorization
 * headers, private keys, or full API response bodies. Buffered entries are the
 * already-redacted records, so exports are as safe as the console output.
 */

/** Fields that must always be redacted before logging. Case-insensitive. */
const REDACTED_FIELDS = new Set([
  'password', 'token', 'accesstoken', 'refreshtoken', 'authorization',
  'cookie', 'set-cookie', 'x-auth-token', 'privatekey', 'encryptedkey',
  'secret', 'apikey', 'api_key', 'dsn', 'connectionstring',
]);

const REDACTED_PLACEHOLDER = '[REDACTED]';

/** Maximum number of log entries retained in memory. */
export const LOG_BUFFER_SIZE = 100;

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

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

/** Fixed-size circular storage; `head` is the slot the next entry will use. */
const buffer = new Array(LOG_BUFFER_SIZE);
let head = 0;
let size = 0;

function pushToBuffer(record) {
  buffer[head] = record;
  head = (head + 1) % LOG_BUFFER_SIZE;
  if (size < LOG_BUFFER_SIZE) size += 1;
}

/**
 * Returns a copy of the buffered log entries, oldest first. At most
 * LOG_BUFFER_SIZE entries are kept; older ones are overwritten.
 *
 * The result is a deep copy, so callers cannot mutate the buffer.
 *
 * @returns {Object[]}
 */
function getRecentLogs() {
  const start = size < LOG_BUFFER_SIZE ? 0 : head;
  const entries = [];
  for (let i = 0; i < size; i += 1) {
    entries.push(redact(buffer[(start + i) % LOG_BUFFER_SIZE]));
  }
  return entries;
}

/** Empties the ring buffer (used by tests and "clear diagnostics" actions). */
function clearLogs() {
  buffer.fill(undefined);
  head = 0;
  size = 0;
}

/**
 * Serializes the buffered logs into a diagnostics JSON document.
 * Never throws: values JSON cannot represent are stringified or dropped.
 *
 * @returns {string}
 */
function serializeLogs() {
  const logs = getRecentLogs();
  const payload = {
    exportedAt: new Date().toISOString(),
    capacity: LOG_BUFFER_SIZE,
    count: logs.length,
    logs,
  };
  try {
    return JSON.stringify(payload, (_key, val) => (typeof val === 'bigint' ? val.toString() : val), 2);
  } catch {
    return JSON.stringify({ ...payload, logs: [], error: 'Logs could not be serialized' }, null, 2);
  }
}

/**
 * Downloads the buffered logs as a JSON file so an operator can attach it to
 * a support ticket. Does nothing outside a browser.
 *
 * @param {string} [filename] - defaults to sendam-logs-<timestamp>.json
 * @returns {string|null} the filename used, or null when no download happened
 */
function downloadLogs(filename) {
  if (typeof document === 'undefined' || typeof Blob === 'undefined' ||
      typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return null;
  }
  const name = filename ||
    `sendam-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const blob = new Blob([serializeLogs()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revoke on the next tick so the browser has started the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return name;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

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

/** Builds the record, stores it in the ring buffer and returns it. */
function record(level, message, context) {
  const entry = buildRecord(level, message, context);
  pushToBuffer(entry);
  return entry;
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
  console.error(record('error', message, context));
}

/**
 * Log a warning (e.g. malformed data shape).
 */
function warn(message, context = {}) {
  // eslint-disable-next-line no-console
  console.warn(record('warn', message, context));
}

/**
 * Log informational events (e.g. error boundary reset / retry).
 */
function info(message, context = {}) {
  // eslint-disable-next-line no-console
  console.info(record('info', message, context));
}

export const logger = { error, warn, info, getRecentLogs, downloadLogs, clearLogs };
