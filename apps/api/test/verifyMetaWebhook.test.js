'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { createVerifyMetaWebhook, validateSignature } = require('../src/middlewares/verifyMetaWebhook');

const TEST_SECRET = 'test_meta_app_secret_abc123';

function computeSignature(payload, secret = TEST_SECRET) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  return 'sha256=' + crypto.createHmac('sha256', secret).update(buf).digest('hex');
}

function createMockReqRes({
  headers = {},
  rawBody = null,
  body = null,
} = {}) {
  const req = {
    headers: { ...headers },
    get: (h) => headers[h] || headers[h.toLowerCase()],
    rawBody,
    body,
    ip: '127.0.0.1',
  };

  let statusCode = 200;
  let jsonResponse = null;
  let ended = false;

  const res = {
    status: (code) => {
      statusCode = code;
      return res;
    },
    json: (data) => {
      jsonResponse = data;
      ended = true;
      return res;
    },
    sendStatus: (code) => {
      statusCode = code;
      ended = true;
      return res;
    },
    getStatusCode: () => statusCode,
    getResponse: () => jsonResponse,
    isEnded: () => ended,
  };

  return { req, res };
}

test('verifyMetaWebhook - valid signature passes and calls next()', (t, done) => {
  const rawBody = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
  const signature = computeSignature(rawBody, TEST_SECRET);

  const alerts = [];
  const middleware = createVerifyMetaWebhook({
    appSecret: TEST_SECRET,
    onSecurityAlert: (reason) => alerts.push(reason),
  });

  const { req, res } = createMockReqRes({
    headers: { 'X-Hub-Signature-256': signature },
    rawBody,
  });

  middleware(req, res, () => {
    // next() was called
    assert.equal(res.isEnded(), false);
    assert.equal(alerts.length, 0);
    done();
  });
});

test('verifyMetaWebhook - missing signature receives 401 Unauthorized and drops with security alert', () => {
  const alerts = [];
  const middleware = createVerifyMetaWebhook({
    appSecret: TEST_SECRET,
    onSecurityAlert: (reason) => alerts.push(reason),
  });

  const { req, res } = createMockReqRes({
    headers: {}, // No signature header
    rawBody: '{"event":"fake_payment"}',
  });

  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false, 'next() must NOT be called for missing signature');
  assert.equal(res.getStatusCode(), 401, 'Must respond with 401 Unauthorized');
  assert.equal(res.getResponse()?.error, 'Unauthorized');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0], 'missing_signature');
});

test('verifyMetaWebhook - forged signature receives 401 Unauthorized and drops with security alert', () => {
  const rawBody = '{"event":"spoofed_transfer","amount":"10000"}';
  const forgedSignature = 'sha256=' + 'a'.repeat(64); // Invalid HMAC

  const alerts = [];
  const middleware = createVerifyMetaWebhook({
    appSecret: TEST_SECRET,
    onSecurityAlert: (reason) => alerts.push(reason),
  });

  const { req, res } = createMockReqRes({
    headers: { 'x-hub-signature-256': forgedSignature },
    rawBody,
  });

  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false, 'next() must NOT be called for forged signature');
  assert.equal(res.getStatusCode(), 401, 'Must respond with 401 Unauthorized');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0], 'forged_signature');
});

test('verifyMetaWebhook - malformed signature format receives 401 Unauthorized', () => {
  const alerts = [];
  const middleware = createVerifyMetaWebhook({
    appSecret: TEST_SECRET,
    onSecurityAlert: (reason) => alerts.push(reason),
  });

  const { req, res } = createMockReqRes({
    headers: { 'X-Hub-Signature-256': 'md5=invalid_prefix_format' },
    rawBody: '{"hello":"world"}',
  });

  middleware(req, res, () => {});

  assert.equal(res.getStatusCode(), 401);
  assert.equal(alerts[0], 'malformed_signature');
});

test('verifyMetaWebhook - secret rotation supports primary and previous secrets', (t, done) => {
  const oldSecret = 'old_secret_xyz';
  const activeSecret = 'active_secret_123';

  const middleware = createVerifyMetaWebhook({
    appSecret: [activeSecret, oldSecret],
  });

  // Signed with old secret during rotation
  const rawBody = '{"action":"payment_confirm"}';
  const oldSig = computeSignature(rawBody, oldSecret);

  const { req, res } = createMockReqRes({
    headers: { 'x-hub-signature-256': oldSig },
    rawBody,
  });

  middleware(req, res, () => {
    assert.equal(res.isEnded(), false);
    done();
  });
});

test('validateSignature helper unit tests', () => {
  const payload = 'raw payload test string';
  const validSig = computeSignature(payload, 'secret1');

  assert.equal(validateSignature(payload, validSig, 'secret1'), true);
  assert.equal(validateSignature(payload, validSig, 'wrong_secret'), false);
  assert.equal(validateSignature(payload + 'tampered', validSig, 'secret1'), false);
  assert.equal(validateSignature(payload, 'invalid_sig', 'secret1'), false);
});
