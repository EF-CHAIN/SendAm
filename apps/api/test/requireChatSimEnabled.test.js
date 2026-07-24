const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Bootstrap: stub dotenv so env.js loads in test environments where dotenv
// is not yet installed (CI pre-install, bare checkout). Has no effect when
// dotenv is present because require() returns the real module first.
// ---------------------------------------------------------------------------
try {
  require('dotenv');
} catch (_) {
  require.cache[require.resolve.paths('dotenv')[0] + '/dotenv'] =
    require.cache['dotenv'] = {
      id: 'dotenv', filename: 'dotenv', loaded: true,
      exports: { config: () => ({}) },
    };
  // Alternative path resolution that Node may use.
  const Module = require('module');
  const origResolve = Module._resolveFilename.bind(Module);
  Module._resolveFilename = (req, ...rest) => {
    if (req === 'dotenv') return req;
    return origResolve(req, ...rest);
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock (req, res, next) triple.
 * res.status() returns res so the chained .json() call works.
 */
function makeCtx() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
  let nextCalled = false;
  const next = () => { nextCalled = true; };
  const req = {};
  return { req, res, next: Object.assign(next, { called: () => nextCalled }) };
}

/**
 * Load requireChatSimEnabled with a specific config snapshot injected.
 * We bypass the module cache so each test gets a fresh closure.
 */
function loadMiddleware(chatSimEnabled) {
  // Bust the require cache for both the middleware and config so the injected
  // value takes effect cleanly.
  delete require.cache[require.resolve('../src/middlewares/requireChatSimEnabled')];
  delete require.cache[require.resolve('../src/config/env')];

  // Temporarily override the env flag.
  const saved = process.env.ENABLE_CHAT_SIM;
  process.env.ENABLE_CHAT_SIM = chatSimEnabled ? 'true' : 'false';

  const middleware = require('../src/middlewares/requireChatSimEnabled');

  // Restore immediately — the config object is already captured inside the
  // module closure we just loaded.
  if (saved === undefined) {
    delete process.env.ENABLE_CHAT_SIM;
  } else {
    process.env.ENABLE_CHAT_SIM = saved;
  }

  return middleware;
}

// ---------------------------------------------------------------------------
// Tests: flag ON
// ---------------------------------------------------------------------------

test('requireChatSimEnabled: flag ON → calls next()', () => {
  const mw = loadMiddleware(true);
  const { req, res, next } = makeCtx();

  mw(req, res, next);

  assert.equal(next.called(), true, 'next() should have been called');
  assert.equal(res.statusCode, null, 'response should not have been written');
});

// ---------------------------------------------------------------------------
// Tests: flag OFF
// ---------------------------------------------------------------------------

test('requireChatSimEnabled: flag OFF → 404 and does not call next()', () => {
  const mw = loadMiddleware(false);
  const { req, res, next } = makeCtx();

  mw(req, res, next);

  assert.equal(next.called(), false, 'next() should not have been called');
  assert.equal(res.statusCode, 404, 'response status should be 404');
});

// ---------------------------------------------------------------------------
// Tests: default behaviour driven by NODE_ENV (no ENABLE_CHAT_SIM set)
// ---------------------------------------------------------------------------

test('requireChatSimEnabled: production + no flag → 404', () => {
  const savedEnv = process.env.NODE_ENV;
  const savedFlag = process.env.ENABLE_CHAT_SIM;

  process.env.NODE_ENV = 'production';
  delete process.env.ENABLE_CHAT_SIM;

  // Bust both caches so NODE_ENV change is picked up by env.js.
  delete require.cache[require.resolve('../src/middlewares/requireChatSimEnabled')];
  delete require.cache[require.resolve('../src/config/env')];

  const mw = require('../src/middlewares/requireChatSimEnabled');
  const { req, res, next } = makeCtx();

  mw(req, res, next);

  // Restore before asserting so a failure doesn't poison subsequent tests.
  process.env.NODE_ENV = savedEnv;
  if (savedFlag === undefined) {
    delete process.env.ENABLE_CHAT_SIM;
  } else {
    process.env.ENABLE_CHAT_SIM = savedFlag;
  }

  assert.equal(next.called(), false, 'next() should not be called in production with flag unset');
  assert.equal(res.statusCode, 404, 'response status should be 404 in production with flag unset');
});

test('requireChatSimEnabled: development + no flag → calls next()', () => {
  const savedEnv = process.env.NODE_ENV;
  const savedFlag = process.env.ENABLE_CHAT_SIM;

  process.env.NODE_ENV = 'development';
  delete process.env.ENABLE_CHAT_SIM;

  delete require.cache[require.resolve('../src/middlewares/requireChatSimEnabled')];
  delete require.cache[require.resolve('../src/config/env')];

  const mw = require('../src/middlewares/requireChatSimEnabled');
  const { req, res, next } = makeCtx();

  mw(req, res, next);

  process.env.NODE_ENV = savedEnv;
  if (savedFlag === undefined) {
    delete process.env.ENABLE_CHAT_SIM;
  } else {
    process.env.ENABLE_CHAT_SIM = savedFlag;
  }

  assert.equal(next.called(), true, 'next() should be called outside production when flag is unset');
  assert.equal(res.statusCode, null, 'response should not have been written outside production');
});

// ---------------------------------------------------------------------------
// Tests: explicit override wins over NODE_ENV
// ---------------------------------------------------------------------------

test('requireChatSimEnabled: production + ENABLE_CHAT_SIM=true → calls next()', () => {
  const savedEnv = process.env.NODE_ENV;
  const savedFlag = process.env.ENABLE_CHAT_SIM;

  process.env.NODE_ENV = 'production';
  process.env.ENABLE_CHAT_SIM = 'true';

  delete require.cache[require.resolve('../src/middlewares/requireChatSimEnabled')];
  delete require.cache[require.resolve('../src/config/env')];

  const mw = require('../src/middlewares/requireChatSimEnabled');
  const { req, res, next } = makeCtx();

  mw(req, res, next);

  process.env.NODE_ENV = savedEnv;
  if (savedFlag === undefined) {
    delete process.env.ENABLE_CHAT_SIM;
  } else {
    process.env.ENABLE_CHAT_SIM = savedFlag;
  }

  assert.equal(next.called(), true, 'explicit ENABLE_CHAT_SIM=true should override production default');
  assert.equal(res.statusCode, null, 'response should not have been written when explicitly enabled');
});

test('requireChatSimEnabled: development + ENABLE_CHAT_SIM=false → 404', () => {
  const savedEnv = process.env.NODE_ENV;
  const savedFlag = process.env.ENABLE_CHAT_SIM;

  process.env.NODE_ENV = 'development';
  process.env.ENABLE_CHAT_SIM = 'false';

  delete require.cache[require.resolve('../src/middlewares/requireChatSimEnabled')];
  delete require.cache[require.resolve('../src/config/env')];

  const mw = require('../src/middlewares/requireChatSimEnabled');
  const { req, res, next } = makeCtx();

  mw(req, res, next);

  process.env.NODE_ENV = savedEnv;
  if (savedFlag === undefined) {
    delete process.env.ENABLE_CHAT_SIM;
  } else {
    process.env.ENABLE_CHAT_SIM = savedFlag;
  }

  assert.equal(next.called(), false, 'explicit ENABLE_CHAT_SIM=false should override development default');
  assert.equal(res.statusCode, 404, 'response status should be 404 when explicitly disabled');
});
