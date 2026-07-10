const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// adminAuth.service validates secrets at require-time, so set them first.
const JWT_SECRET = 'test-jwt-secret-that-is-definitely-long-enough';
const ADMIN_PASSWORD = 'correct horse battery staple';
process.env.JWT_SECRET = JWT_SECRET;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

const { verifyPassword, createToken, verifyToken } = require('../src/services/adminAuth.service');

// Mirror the service's signing so we can forge tokens for negative tests.
const sign = (body) => crypto.createHmac('sha256', JWT_SECRET).update(body).digest('base64url');
const encodeBody = (payload) => Buffer.from(JSON.stringify(payload)).toString('base64url');

test('verifyPassword: correct password', () => {
  assert.equal(verifyPassword(ADMIN_PASSWORD), true);
});

test('verifyPassword: wrong / empty / non-string', () => {
  assert.equal(verifyPassword('wrong'), false);
  assert.equal(verifyPassword(''), false);
  assert.equal(verifyPassword(undefined), false);
  assert.equal(verifyPassword(null), false);
});

test('createToken -> verifyToken round-trips an admin session', () => {
  const payload = verifyToken(createToken());
  assert.ok(payload);
  assert.equal(payload.role, 'admin');
  assert.ok(payload.exp > Date.now());
});

test('a token with a forged signature is rejected', () => {
  const body = encodeBody({ role: 'admin', iat: Date.now(), exp: Date.now() + 10000 });
  assert.equal(verifyToken(`${body}.deadbeef`), null);
});

test('an expired token is rejected even with a valid signature', () => {
  const body = encodeBody({ role: 'admin', iat: Date.now() - 20000, exp: Date.now() - 10000 });
  assert.equal(verifyToken(`${body}.${sign(body)}`), null);
});

test('a non-admin role is rejected even with a valid signature', () => {
  const body = encodeBody({ role: 'user', iat: Date.now(), exp: Date.now() + 10000 });
  assert.equal(verifyToken(`${body}.${sign(body)}`), null);
});

test('malformed tokens are rejected', () => {
  assert.equal(verifyToken('garbage'), null);
  assert.equal(verifyToken(''), null);
  assert.equal(verifyToken(null), null);
});
