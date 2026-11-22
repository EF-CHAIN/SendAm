'use strict';

/**
 * @fileoverview Exponential backoff with full jitter for transient network and
 * Horizon errors.
 *
 * Retrying immediately (or on a fixed schedule) during a Horizon rate limit
 * (HTTP 429) synchronises every worker onto the same retry instant and makes the
 * throttling worse. "Full jitter" spreads retries across a randomised window:
 *
 *   sleep = rand(0, min(maxBackoff, baseBackoff * 2^attempt))
 *
 * (AWS Architecture Blog, "Exponential Backoff And Jitter").
 */

const DEFAULTS = {
  baseMs: Number(process.env.RETRY_BASE_BACKOFF_MS || 1000),
  maxMs: Number(process.env.RETRY_MAX_BACKOFF_MS || 60000),
};

// Name used as `backoff.type` on BullMQ jobs; resolved by bullBackoffStrategy.
const FULL_JITTER_BACKOFF_TYPE = 'full-jitter';

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT',
  'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
]);

const positive = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);

/**
 * Upper bound of the jitter window for a given attempt:
 * min(maxMs, baseMs * 2^attempt).
 *
 * @param {number} attempt - zero-based retry number (0 = first retry).
 * @param {{ baseMs?: number, maxMs?: number }} [options]
 * @returns {number}
 */
const backoffCeiling = (attempt, options = {}) => {
  const baseMs = positive(options.baseMs, DEFAULTS.baseMs);
  const maxMs = positive(options.maxMs, DEFAULTS.maxMs);
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  // Cap the exponent so 2 ** n never overflows to Infinity for huge attempts.
  return Math.min(maxMs, baseMs * 2 ** Math.min(n, 30));
};

/**
 * Full-jitter delay: a uniformly random integer in [0, backoffCeiling(attempt)].
 *
 * @param {number} attempt - zero-based retry number.
 * @param {{ baseMs?: number, maxMs?: number, random?: () => number }} [options]
 *   `random` is injectable for deterministic tests; must return a value in [0, 1).
 * @returns {number} delay in milliseconds.
 */
const fullJitterDelay = (attempt, options = {}) => {
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const r = Math.min(Math.max(Number(random()) || 0, 0), 0.999999999);
  return Math.floor(r * (backoffCeiling(attempt, options) + 1));
};

const statusOf = (error) => Number(
  error?.response?.status ?? error?.status ?? error?.statusCode ?? error?.response?.statusCode,
);

/**
 * Whether an error is a transient network / Horizon condition worth retrying:
 * 408, 425, 429, 5xx, or a low-level network failure.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
const isTransientError = (error) => {
  if (!error) return false;
  const status = statusOf(error);
  if (Number.isFinite(status)) {
    return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
  }
  const code = String(error.code || error.cause?.code || '').toUpperCase();
  return TRANSIENT_NETWORK_CODES.has(code);
};

/**
 * Server-requested wait (Retry-After header, in seconds or an HTTP date) in
 * milliseconds, or null when absent/invalid.
 *
 * @param {unknown} error
 * @returns {number|null}
 */
const retryAfterMs = (error) => {
  const headers = error?.response?.headers;
  if (!headers) return null;
  const raw = typeof headers.get === 'function'
    ? headers.get('retry-after')
    : (headers['retry-after'] ?? headers['Retry-After']);
  if (raw == null || raw === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : null;
  const date = Date.parse(String(raw));
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
};

/**
 * Delay before the next retry. Full jitter, but never shorter than a
 * server-provided Retry-After (which is itself capped at maxMs so one bad
 * header cannot park a worker indefinitely).
 *
 * @param {number} attempt - zero-based retry number.
 * @param {unknown} [error]
 * @param {{ baseMs?: number, maxMs?: number, random?: () => number }} [options]
 * @returns {number}
 */
const computeRetryDelay = (attempt, error, options = {}) => {
  const jittered = fullJitterDelay(attempt, options);
  const serverWait = retryAfterMs(error);
  if (serverWait == null) return jittered;
  const maxMs = positive(options.maxMs, DEFAULTS.maxMs);
  return Math.max(jittered, Math.min(serverWait, maxMs));
};

/**
 * BullMQ `settings.backoffStrategy`. A job opts in with
 * `backoff: { type: 'full-jitter', delay: <baseMs> }`; other types return
 * undefined so BullMQ's built-in handling still applies to them.
 *
 * @param {number} attemptsMade - attempts so far (>= 1 when called by BullMQ).
 * @param {string} type
 * @param {Error} [error]
 * @param {{ opts?: { backoff?: { delay?: number } } }} [job]
 * @returns {number|undefined}
 */
const bullBackoffStrategy = (attemptsMade, type, error, job) => {
  if (type !== FULL_JITTER_BACKOFF_TYPE) return undefined;
  const baseMs = positive(job?.opts?.backoff?.delay, DEFAULTS.baseMs);
  return computeRetryDelay(Math.max(0, Number(attemptsMade || 1) - 1), error, { baseMs });
};

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Run `fn`, retrying transient failures with full-jitter backoff. Non-transient
 * errors are thrown immediately; the last error is thrown when attempts run out.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} fn
 * @param {{ retries?: number, baseMs?: number, maxMs?: number, random?: () => number,
 *   sleep?: (ms: number) => Promise<void>, shouldRetry?: (e: unknown) => boolean,
 *   onRetry?: (info: { attempt: number, delayMs: number, error: unknown }) => void }} [options]
 * @returns {Promise<T>}
 */
const retryWithBackoff = async (fn, options = {}) => {
  const retries = Number.isInteger(options.retries) && options.retries >= 0 ? options.retries : 5;
  const shouldRetry = options.shouldRetry || isTransientError;
  const sleep = options.sleep || defaultSleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= retries || !shouldRetry(error)) throw error;
      const delayMs = computeRetryDelay(attempt, error, options);
      if (typeof options.onRetry === 'function') options.onRetry({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs);
    }
  }
};

module.exports = {
  FULL_JITTER_BACKOFF_TYPE,
  backoffCeiling,
  fullJitterDelay,
  isTransientError,
  retryAfterMs,
  computeRetryDelay,
  bullBackoffStrategy,
  retryWithBackoff,
};
