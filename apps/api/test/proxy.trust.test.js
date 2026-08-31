const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeTrustProxy, getTrustProxySetting, getClientIp, sanitizeForwardingHeaders } = require('../src/config/proxy');

test('normalizeTrustProxy accepts integer hop counts and CIDR-like entries', () => {
  assert.equal(normalizeTrustProxy('1'), 1);
  assert.deepEqual(normalizeTrustProxy('10.0.0.0/8, 10.10.0.0/16'), ['10.0.0.0/8', '10.10.0.0/16']);
  assert.equal(normalizeTrustProxy('false'), false);
});

test('trusted proxy requests keep the upstream client IP from Express', () => {
  const req = {
    app: { get: () => 1 },
    ip: '203.0.113.9',
    headers: { 'x-forwarded-for': '10.0.0.5, 203.0.113.9', 'x-real-ip': '10.0.0.5' },
  };

  assert.equal(getClientIp(req), '203.0.113.9');
  sanitizeForwardingHeaders(req);
  assert.equal(req.headers['x-forwarded-for'], '10.0.0.5, 203.0.113.9');
});

test('untrusted requests reject spoofed forwarding headers', () => {
  const req = {
    app: { get: () => false },
    socket: { remoteAddress: '198.51.100.10' },
    headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'x-real-ip': '203.0.113.7', forwarded: 'for=203.0.113.7' },
  };

  sanitizeForwardingHeaders(req);
  assert.equal(req.headers['x-forwarded-for'], undefined);
  assert.equal(req.headers['x-real-ip'], undefined);
  assert.equal(req.headers.forwarded, undefined);
  assert.equal(getClientIp(req), '198.51.100.10');
});

test('production default is one trusted proxy hop unless overridden', () => {
  const original = process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY;
  process.env.NODE_ENV = 'production';

  try {
    assert.equal(getTrustProxySetting(), 1);
  } finally {
    if (original === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = original;
  }
});
