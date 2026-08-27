// Build the versioned error envelope returned to clients:
//
//   {
//     success: false,
//     message: "<human-readable, client-safe>",
//     error: {
//       version: "1.0",
//       code: "validation_error",
//       message: "<same client-safe message>",
//       correlationId: "<uuid>",
//       details?: { ... }
//     }
//   }
//
// The whole payload is passed through the logger sanitizer so a nested secret
// (e.g. a validation detail echoing a token) can never reach a response body.
const logger = require('../utils/logger');
const { getContext } = require('../observability/context');
const { ENVELOPE_VERSION } = require('./catalog');
const { normalizeError } = require('./mapError');

const errorEnvelope = (error, { correlationId, normalized } = {}) => {
  const result = normalized || normalizeError(error);
  const id = correlationId || getContext().correlationId || null;
  const payload = {
    success: false,
    message: result.message,
    error: {
      version: ENVELOPE_VERSION,
      code: result.code,
      message: result.message,
      correlationId: id,
      ...(result.details !== undefined ? { details: result.details } : {}),
    },
  };
  return logger.sanitize(payload);
};

module.exports = { errorEnvelope };
