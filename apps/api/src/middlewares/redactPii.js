'use strict';

// PII and secret redaction shared by the logger and the HTTP request log.
//
// Logs are exported to third-party systems (Datadog, CloudWatch), so Stellar
// secret keys, PINs and customer phone numbers must never reach any log
// stream. This module has no dependencies on the logger so the logger can
// import it without a cycle.

const REDACTED = '[REDACTED]';
const REDACTED_PHONE = '[REDACTED_PHONE]';
const REDACTED_SECRET_KEY = '[REDACTED_SECRET_KEY]';

const SENSITIVE_KEY = /(?:authorization|cookie|password|passphrase|pin|secret|token|signature|private.?key|encrypted.?secret|api.?key|dsn)/i;
const PHONE_KEY = /(?:phone|msisdn|mobile|wa.?id|whatsapp.?number)/i;

// Order matters: the secret key pattern runs first so a key embedded in a
// longer string is replaced as a unit.
const TEXT_RULES = [
  // Stellar secret seed: 'S' followed by 55 base32 characters.
  { pattern: /(?<![A-Z0-9])S[A-Z0-9]{55}(?![A-Z0-9])/g, replace: REDACTED_SECRET_KEY },
  // key=value / key: value forms for credentials, including JSON-quoted keys.
  {
    pattern: /(\b(?:pin|passcode|password|passphrase|secret|token|authorization|api[_-]?key)\b["']?\s*[:=]\s*["']?)[^\s,;"'&}]+/gi,
    replace: `$1${REDACTED}`,
  },
  // Prose forms such as "PIN is 1234" or "pin 4821".
  { pattern: /(\bpin\b(?:\s+(?:is|code))?\s+)\d{4,6}\b/gi, replace: `$1${REDACTED}` },
  { pattern: /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, replace: `$1${REDACTED}` },
  { pattern: /([?&](?:access_token|token|api_key)=)[^&\s]+/gi, replace: `$1${REDACTED}` },
  // Labelled phone numbers in any country format.
  {
    pattern: /(\b(?:phone(?:[_\s-]?number)?|msisdn|mobile|wa[_-]?id)\b["']?\s*[:=]\s*["']?)\+?\d[\d\s().-]{5,}\d/gi,
    replace: `$1${REDACTED_PHONE}`,
  },
  // E.164 numbers with a leading plus.
  { pattern: /(?<![\w.])\+\d[\d\s().-]{6,16}\d(?!\d)/g, replace: REDACTED_PHONE },
  // Nigerian numbers without a plus: 234XXXXXXXXXX and 0XXXXXXXXXX.
  { pattern: /(?<![\w.])(?:234[789]\d{9}|0[789]\d{9})(?!\d)/g, replace: REDACTED_PHONE },
];

const redactString = (value) => {
  if (typeof value !== 'string' || value === '') return value;
  return TEXT_RULES.reduce((text, rule) => text.replace(rule.pattern, rule.replace), value);
};

/** Replacement for the value stored under a sensitive key, or null if the key is safe. */
const redactionForKey = (key) => {
  if (PHONE_KEY.test(key)) return REDACTED_PHONE;
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  return null;
};

/** morgan `:url` token that strips PII and credentials from query strings. */
const redactedUrlToken = (req) => redactString(req.originalUrl || req.url || '');

/**
 * Express middleware exposing redacted request details for downstream log
 * statements, so handlers never need to log raw `req.originalUrl`.
 */
const redactPii = (req, _res, next) => {
  req.redactedUrl = redactedUrlToken(req);
  next();
};

module.exports = {
  REDACTED,
  REDACTED_PHONE,
  REDACTED_SECRET_KEY,
  redactPii,
  redactString,
  redactedUrlToken,
  redactionForKey,
};
