const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sendSuccess, sendError, sendPaginated, sendCursorPaginated } = require('../src/utils/response');
const { runWithContext } = require('../src/observability/context');

const makeRes = () => {
  const res = { statusCode: 200 };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

test('success responses carry the correlation id in the body', () => {
  const res = makeRes();
  runWithContext({ correlationId: 'corr-ok-1' }, () => sendSuccess(res, { balance: '10' }, 'Balances fetched'));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.correlationId, 'corr-ok-1');
  assert.equal(res.body.data.balance, '10');
});

test('error responses use the versioned envelope with a stable code and correlation id', () => {
  const res = makeRes();
  runWithContext({ correlationId: 'corr-err-1' }, () => sendError(res, 'Wallet not found', 404));
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error.code, 'not_found');
  assert.equal(res.body.error.version, '1.0');
  assert.equal(res.body.error.correlationId, 'corr-err-1');
  assert.equal(res.body.error.message, 'Wallet not found');
  assert.equal(res.body.message, 'Wallet not found');
});

test('validation errors via sendError map to validation_error', () => {
  const res = makeRes();
  runWithContext({ correlationId: 'corr-err-2' }, () => sendError(res, 'A valid amount and destination are required'));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'validation_error');
});

test('paginated responses carry the correlation id', () => {
  const res = makeRes();
  runWithContext(
    { correlationId: 'corr-page-1' },
    () => sendPaginated(res, [{ id: 'a' }], { page: 1, limit: 50, total: 1 }, 'Listed'),
  );
  assert.equal(res.body.correlationId, 'corr-page-1');
  assert.equal(res.body.data.length, 1);

  const cursorRes = makeRes();
  runWithContext(
    { correlationId: 'corr-page-2' },
    () => sendCursorPaginated(cursorRes, [], { limit: 50, nextCursor: null }),
  );
  assert.equal(cursorRes.body.correlationId, 'corr-page-2');
});
