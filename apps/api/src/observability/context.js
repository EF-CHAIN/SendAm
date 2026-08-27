const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');

const storage = new AsyncLocalStorage();
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const correlationIdFrom = (candidate) => (
  typeof candidate === 'string' && SAFE_ID.test(candidate) ? candidate : randomUUID()
);

const runWithContext = (context, callback) => storage.run(Object.freeze({ ...context }), callback);
const getContext = () => storage.getStore() || {};

// Headers to attach to outbound provider requests so the current request's
// correlation ID travels end-to-end (API -> provider) and can be matched in
// provider logs. Empty object when no correlation ID is in flight.
const outboundHeaders = () => {
  const { correlationId } = storage.getStore() || {};
  return correlationId ? { 'x-correlation-id': correlationId } : {};
};

const correlationMiddleware = (req, res, next) => {
  const correlationId = correlationIdFrom(req.get('x-correlation-id') || req.get('x-request-id'));
  res.set('x-correlation-id', correlationId);
  runWithContext({
    correlationId,
    requestId: correlationId,
    method: req.method,
    path: req.path,
  }, next);
};

module.exports = {
  correlationMiddleware,
  correlationIdFrom,
  runWithContext,
  getContext,
  outboundHeaders,
};
