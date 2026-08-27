const logger = require('../utils/logger');
const { captureException } = require('../observability/errors');
const { getContext } = require('../observability/context');
const { normalizeError } = require('../errors');
const { errorEnvelope } = require('../errors/envelope');

// Express identifies error-handling middleware by arity (4 params). The `_req`
// and `_next` arguments must be declared even though they are unused here —
// removing them would demote this to a regular middleware and break error
// propagation.
const errorHandler = (err, req, res, _next) => {
  const normalized = normalizeError(err);
  const correlationId = getContext().correlationId || null;

  logger.error('http_request_exception', {
    error: err,
    code: normalized.code,
    statusCode: normalized.statusCode,
    method: req.method,
    path: req.path,
  });
  captureException(err, {
    source: 'http',
    code: normalized.code,
    method: req.method,
    path: req.path,
  });

  if (correlationId && !res.get('x-correlation-id')) {
    res.set('x-correlation-id', correlationId);
  }
  res.status(normalized.statusCode).json(errorEnvelope(err, { correlationId, normalized }));
};

module.exports = errorHandler;
