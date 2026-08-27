// Error type that carries a stable catalog code, an HTTP status, and a flag
// for whether its message may be shown to clients. Throwing AppError from
// controllers/services lets callers (and the error handler) respond with a
// machine-readable code instead of guessing from the message.
const { CATALOG, byCode } = require('./catalog');

class AppError extends Error {
  constructor(code, message, { statusCode, details, safe } = {}) {
    const entry = typeof code === 'string' ? byCode(code) : null;
    super(message || (entry && entry.defaultMessage) || CATALOG.INTERNAL.defaultMessage);
    this.name = 'AppError';
    this.code = entry ? entry.code : code;
    this.statusCode = statusCode || (entry ? entry.statusCode : CATALOG.INTERNAL.statusCode);
    this.safe = safe !== undefined ? safe : (entry ? entry.safe : CATALOG.INTERNAL.safe);
    if (details !== undefined) this.details = details;
  }

  static validation(message, details) {
    return new AppError('validation_error', message, { details });
  }

  static unauthorized(message) {
    return new AppError('unauthorized', message);
  }

  static forbidden(message) {
    return new AppError('forbidden', message);
  }

  static notFound(message) {
    return new AppError('not_found', message);
  }

  static conflict(message, details) {
    return new AppError('conflict', message, { details });
  }

  static rateLimited(message) {
    return new AppError('rate_limited', message);
  }

  static provider(message, details) {
    return new AppError('provider_error', message, { details });
  }

  static unavailable(message) {
    return new AppError('service_unavailable', message);
  }

  static internal(message) {
    return new AppError('internal_error', message, { safe: false });
  }
}

module.exports = { AppError };
