const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CATALOG, ENVELOPE_VERSION, byCode, keyForStatusCode } = require('../src/errors/catalog');

test('error envelope version is stable and semver-like', () => {
  assert.match(ENVELOPE_VERSION, /^\d+\.\d+$/);
});

test('catalog exposes stable machine-readable codes with unique statuses', () => {
  const codes = Object.values(CATALOG).map((entry) => entry.code);
  const statuses = Object.values(CATALOG).map((entry) => entry.statusCode);
  assert.equal(new Set(codes).size, codes.length, 'codes must be unique');
  assert.equal(new Set(statuses).size, statuses.length, 'statuses must be unique');
  codes.forEach((code) => assert.match(code, /^[a-z_]+$/));
});

test('catalog covers the required failure categories', () => {
  const codes = Object.values(CATALOG).map((entry) => entry.code);
  for (const expected of [
    'validation_error',
    'unauthorized',
    'forbidden',
    'not_found',
    'conflict',
    'rate_limited',
    'provider_error',
    'internal_error',
  ]) {
    assert.ok(codes.includes(expected), `missing catalog code ${expected}`);
  }
});

test('catalog maps the canonical HTTP statuses', () => {
  assert.equal(keyForStatusCode(400), 'VALIDATION');
  assert.equal(keyForStatusCode(401), 'UNAUTHORIZED');
  assert.equal(keyForStatusCode(403), 'FORBIDDEN');
  assert.equal(keyForStatusCode(404), 'NOT_FOUND');
  assert.equal(keyForStatusCode(409), 'CONFLICT');
  assert.equal(keyForStatusCode(429), 'RATE_LIMITED');
  assert.equal(keyForStatusCode(502), 'PROVIDER');
  assert.equal(keyForStatusCode(503), 'UNAVAILABLE');
  assert.equal(keyForStatusCode(500), 'INTERNAL');
});

test('unknown statuses and codes degrade to internal_error', () => {
  assert.equal(keyForStatusCode(418), 'INTERNAL');
  assert.equal(byCode('no_such_code'), null);
  assert.equal(byCode('internal_error').code, 'internal_error');
});
