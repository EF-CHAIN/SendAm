const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveTarget, TargetRefused, DEFAULT_TARGET } = require('../load/lib/target');

test('defaults to localhost when nothing is configured', () => {
  const { url, isLocal } = resolveTarget({ env: {} });
  assert.equal(url.origin, new URL(DEFAULT_TARGET).origin);
  assert.equal(isLocal, true);
});

test('refuses a remote host unless LOAD_ALLOW_REMOTE is set', () => {
  assert.throws(
    () => resolveTarget({ target: 'https://api.sendam.example', env: {} }),
    (error) => error instanceof TargetRefused && /LOAD_ALLOW_REMOTE/.test(error.message),
  );
});

test('allows a remote host once explicitly opted in', () => {
  const { url, isLocal } = resolveTarget({
    target: 'https://staging.sendam.example',
    env: { LOAD_ALLOW_REMOTE: 'true' },
  });
  assert.equal(url.hostname, 'staging.sendam.example');
  assert.equal(isLocal, false);
});

test('refuses to generate load at all when NODE_ENV is production', () => {
  // Even against localhost: NODE_ENV=production means this process is
  // configured as production and must not be a load source.
  assert.throws(
    () => resolveTarget({ env: { NODE_ENV: 'production' } }),
    (error) => error instanceof TargetRefused && /LOAD_ALLOW_PRODUCTION/.test(error.message),
  );
});

test('the production guard is independent of the remote guard', () => {
  // Opting into remote must not silently unlock production.
  assert.throws(
    () => resolveTarget({
      target: 'https://staging.sendam.example',
      env: { NODE_ENV: 'production', LOAD_ALLOW_REMOTE: 'true' },
    }),
    /LOAD_ALLOW_PRODUCTION/,
  );
});

test('rejects a non-http target and an unparseable one', () => {
  assert.throws(() => resolveTarget({ target: 'ftp://example.com', env: {} }), /http or https/);
  assert.throws(() => resolveTarget({ target: 'not a url', env: {} }), /not a valid URL/);
});

test('treats the usual local aliases as local', () => {
  for (const host of ['http://localhost:3002', 'http://127.0.0.1:3002', 'http://[::1]:3002']) {
    assert.equal(resolveTarget({ target: host, env: {} }).isLocal, true, host);
  }
});
