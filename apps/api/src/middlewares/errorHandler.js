const logger = require('../utils/logger');
const { captureException } = require('../observability/errors');
const { getContext } = require('../observability/context');
const { normalizeError } = require('../errors');
const { errorEnvelope } = require('../errors/envelope');

// Express identifies error-handling middleware by arity (4 params). The `_req`
// and `_next` arguments must be declared even though they are unused here —
// removing them would demote this to a regular middleware and break error
// propagation.
const errorHandler = (err, _req, res, _next) => {
  logger.error(err.stack);

  const statusCode = err.statusCode || (res.statusCode === 200 ? 500 : res.statusCode);

  res.status(statusCode).json({
    success: false,
    message: err.message || 'Server Error',
    errors: err.errors || undefined,
    stack: process.env.NODE_ENV === 'production' ? null : err.stack,
  });

  if (correlationId && !res.get('x-correlation-id')) {
    res.set('x-correlation-id', correlationId);
  }
  res.status(normalized.statusCode).json(errorEnvelope(err, { correlationId, normalized }));
};

module.exports = errorHandler;
