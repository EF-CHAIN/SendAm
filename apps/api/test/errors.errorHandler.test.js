const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const logged = [];
const captured = [];
const realLogger = require('../src/utils/logger');

const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

inject('utils/logger', {
  info: () => {},
  warn: () => {},
  error: (message, data) => { logged.push({ message, data }); },
  sanitize: realLogger.sanitize,
});
inject('observability/errors', {
  captureException: async (error, extra) => { captured.push({ error, extra }); },
  initializeErrorMonitoring: () => {},
});

const errorHandler = require('../src/middlewares/errorHandler');
const { runWithContext } = require('../src/observability/context');

const makeRes = () => {
  const headers = {};
  const res = { headers, statusCode: 200, headersSent: false };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.set = (name, value) => { headers[name] = value; };
  res.get = (name) => headers[name];
  return res;
};
const makeReq = () => ({ method: 'POST', path: '/api/wallet/send' });

beforeEach(() => {
  logged.length = 0;
  captured.length = 0;
});

test('error handler returns a stable code, status, and correlation id', () => {
  const res = makeRes();
  const { AppError } = require('../src/errors');
  const error = new AppError('validation_error', 'A valid amount is required');
  runWithContext({ correlationId: 'corr-handler-1' }, () => errorHandler(error, makeReq(), res, () => {}));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error.code, 'validation_error');
  assert.equal(res.body.error.version, '1.0');
  assert.equal(res.body.error.correlationId, 'corr-handler-1');
  assert.equal(res.headers['x-correlation-id'], 'corr-handler-1');
});

test('internal errors return a generic message and never a stack trace', () => {
  const res = makeRes();
  const error = new Error('secret=abc123 at /srv/app/config');
  runWithContext({ correlationId: 'corr-handler-2' }, () => errorHandler(error, makeReq(), res, () => {}));
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.code, 'internal_error');
  assert.equal(res.body.error.message, 'An unexpected error occurred.');
  assert.doesNotMatch(JSON.stringify(res.body), /secret|abc123|\/srv/);
});

test('errors with a statusCode map through the catalog', () => {
  const res = makeRes();
  const error = new Error('Expired challenge');
  error.statusCode = 409;
  runWithContext({ correlationId: 'corr-handler-3' }, () => errorHandler(error, makeReq(), res, () => {}));
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.code, 'conflict');
  assert.equal(res.body.error.message, 'Expired challenge');
});

test('error is logged and reported to the monitor with the stable code', () => {
  const res = makeRes();
  const { AppError } = require('../src/errors');
  runWithContext(
    { correlationId: 'corr-handler-4' },
    () => errorHandler(new AppError('rate_limited'), makeReq(), res, () => {}),
  );
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error.code, 'rate_limited');
  assert.ok(logged.some((entry) => entry.message === 'http_request_exception' && entry.data.code === 'rate_limited'));
  assert.ok(captured.some((entry) => entry.extra.code === 'rate_limited' && entry.extra.source === 'http'));
});
