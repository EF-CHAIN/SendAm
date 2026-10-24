// Error type that carries a stable catalog code, an HTTP status, and a flag
// for whether its message may be shown to clients. Throwing AppError from
// controllers/services lets callers (and the error handler) respond with a
// machine-readable code instead of guessing from the message.
const { CATALOG, byCode } = require('./catalog');

class AppError extends Error {
  constructor(code, message, { statusCode, details, safe, cause } = {}) {
    const entry = typeof code === 'string' ? byCode(code) : null;
    super(
      message || (entry && entry.defaultMessage) || CATALOG.INTERNAL.defaultMessage,
      cause !== undefined ? { cause } : undefined
    );
    this.name = 'AppError';
    this.code = entry ? entry.code : code;
    this.statusCode = statusCode || (entry ? entry.statusCode : CATALOG.INTERNAL.statusCode);
    this.safe = safe !== undefined ? safe : (entry ? entry.safe : CATALOG.INTERNAL.safe);
    if (details !== undefined) this.details = details;
    if (cause !== undefined && this.cause === undefined) this.cause = cause;
  }

  static validation(message, details, { cause } = {}) {
    return new AppError('validation_error', message, { details, cause });
  }

  static unauthorized(message, { cause } = {}) {
    return new AppError('unauthorized', message, { cause });
  }

  static forbidden(message, { cause } = {}) {
    return new AppError('forbidden', message, { cause });
  }

  static notFound(message, { cause } = {}) {
    return new AppError('not_found', message, { cause });
  }

  static conflict(message, details, { cause } = {}) {
    return new AppError('conflict', message, { details, cause });
  }

  static rateLimited(message, { cause } = {}) {
    return new AppError('rate_limited', message, { cause });
  }

  static provider(message, details, { cause } = {}) {
    return new AppError('provider_error', message, { details, cause });
  }

  static unavailable(message, { cause } = {}) {
    return new AppError('service_unavailable', message, { cause });
  }

  static internal(message, { cause } = {}) {
    return new AppError('internal_error', message, { safe: false, cause });
  }
}

module.exports = { AppError };
