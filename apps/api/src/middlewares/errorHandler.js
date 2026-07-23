const logger = require('../utils/logger');

// Express identifies error-handling middleware by arity (4 params). The `_req`
// and `_next` arguments must be declared even though they are unused here —
// removing them would demote this to a regular middleware and break error
// propagation.
const errorHandler = (err, _req, res, _next) => {
  logger.error(err.stack);
  
  const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
  
  res.status(statusCode).json({
    success: false,
    message: err.message || 'Server Error',
    stack: process.env.NODE_ENV === 'production' ? null : err.stack,
  });
};

module.exports = errorHandler;
