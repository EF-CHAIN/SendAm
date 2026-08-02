const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const injectMock = (relativeFromSrc, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

const config = {
  isProduction: true,
  whatsapp: { verifyToken: 'production-verify-token', appSecret: 'production-app-secret' },
};
const events = [];
injectMock('config/env', config);
injectMock('utils/logger', {
  info: (...args) => events.push(['info', ...args]),
  warn: (...args) => events.push(['warn', ...args]),
  error: (...args) => events.push(['error', ...args]),
});

const verifyWebhook = require('../src/middlewares/verifyWebhook');
const verifyWhatsappSignature = require('../src/middlewares/verifyWhatsappSignature');

const response = () => ({
  statusCode: null,
  headers: {},
  sendStatus(code) { this.statusCode = code; return this; },
  set(name, value) { this.headers[name] = value; return this; },
});

beforeEach(() => {
  events.length = 0;
  config.isProduction = true;
  config.whatsapp.verifyToken = 'production-verify-token';
  config.whatsapp.appSecret = 'production-app-secret';
});

test('production verification handshake accepts the configured token', () => {
  const req = {
    query: {
      'hub.mode': 'subscribe',
      'hub.verify_token': 'production-verify-token',
      'hub.challenge': 'challenge-123',
    },
  };
  const res = response();
  let called = false;
  verifyWebhook(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(events[0][1], 'whatsapp_webhook_verification_succeeded');
});

test('verification handshake rejects wrong tokens and malformed requests', () => {
  const wrong = response();
  verifyWebhook({
    query: {
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong',
      'hub.challenge': 'challenge-123',
    },
  }, wrong, () => assert.fail('must not call next'));
  assert.equal(wrong.statusCode, 403);

  const malformed = response();
  verifyWebhook({ query: {} }, malformed, () => assert.fail('must not call next'));
  assert.equal(malformed.statusCode, 400);
});

test('signed POST verifies the exact raw request body', () => {
  const rawBody = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');
  const signature = 'sha256=' + crypto
    .createHmac('sha256', config.whatsapp.appSecret)
    .update(rawBody)
    .digest('hex');
  const req = { rawBody, get: () => signature };
  const res = response();
  let called = false;
  verifyWhatsappSignature(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(events[0][1], 'whatsapp_webhook_signature_verified');
});

test('POST signature check rejects missing, malformed, and mismatched signatures', () => {
  for (const signature of ['', 'sha256=xyz', `sha256=${'0'.repeat(64)}`]) {
    const req = { rawBody: Buffer.from('{}'), get: () => signature };
    const res = response();
    verifyWhatsappSignature(req, res, () => assert.fail('must not call next'));
    assert.equal(res.statusCode, 403);
  }
});

test('production POST fails closed when the app secret is absent', () => {
  config.whatsapp.appSecret = undefined;
  const res = response();
  verifyWhatsappSignature(
    { rawBody: Buffer.from('{}'), get: () => '' },
    res,
    () => assert.fail('must not call next'),
  );
  assert.equal(res.statusCode, 403);
});
