// Versioned API error envelope + stable machine-readable code catalog.
//
// Every error response carries `error: { version, code, message, correlationId, details? }`.
// The `code` is the stable contract clients should branch on — never parse the
// human-readable `message`. Codes are mapped to an HTTP status, and each entry
// declares whether its message is safe to expose to clients:
//
//   - safe (true):  the message describes the failure for a user/developer.
//   - safe (false): never surfaced verbatim (internal errors can leak secrets,
//                   file paths, provider details) — a generic message is sent
//                   and the real error is only logged / reported.
//
// Bump `ENVELOPE_VERSION` only when the envelope shape changes in a breaking
// way; adding codes is non-breaking and needs no version bump.

const ENVELOPE_VERSION = '1.0';

const CATALOG = Object.freeze({
  VALIDATION: {
    code: 'validation_error',
    statusCode: 400,
    safe: true,
    defaultMessage: 'The request is invalid.',
  },
  UNAUTHORIZED: {
    code: 'unauthorized',
    statusCode: 401,
    safe: true,
    defaultMessage: 'Authentication is required.',
  },
  FORBIDDEN: {
    code: 'forbidden',
    statusCode: 403,
    safe: true,
    defaultMessage: 'You are not allowed to perform this action.',
  },
  NOT_FOUND: {
    code: 'not_found',
    statusCode: 404,
    safe: true,
    defaultMessage: 'The requested resource was not found.',
  },
  CONFLICT: {
    code: 'conflict',
    statusCode: 409,
    safe: true,
    defaultMessage: 'The request conflicts with the current state.',
  },
  RATE_LIMITED: {
    code: 'rate_limited',
    statusCode: 429,
    safe: true,
    defaultMessage: 'Too many requests. Try again later.',
  },
  PROVIDER: {
    code: 'provider_error',
    statusCode: 502,
    safe: true,
    defaultMessage: 'An upstream provider returned an error.',
  },
  UNAVAILABLE: {
    code: 'service_unavailable',
    statusCode: 503,
    safe: true,
    defaultMessage: 'The service is temporarily unavailable.',
  },
  INTERNAL: {
    code: 'internal_error',
    statusCode: 500,
    safe: false,
    defaultMessage: 'An unexpected error occurred.',
  },
});

const byCode = (code) => (
  Object.values(CATALOG).find((entry) => entry.code === code) || null
);

const keyForStatusCode = (statusCode) => (
  Object.keys(CATALOG).find((key) => CATALOG[key].statusCode === statusCode) || 'INTERNAL'
);

module.exports = { CATALOG, ENVELOPE_VERSION, byCode, keyForStatusCode };
