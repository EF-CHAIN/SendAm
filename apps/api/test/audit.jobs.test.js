'use strict';

// Audit log integrity poller unit tests — #444
//
// Covers src/jobs/audit.jobs.js: the poller runs an integrity sweep
// immediately, re-runs it on the configured interval, survives sweep
// failures, and stops cleanly. setInterval is driven by node:test mock
// timers, so no real time passes. The audit service and logger are
// in-memory fakes injected before the SUT is loaded.

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const injectMock = (relFromSrc, factory) => {
  const abs = path.resolve(__dirname, '../src', `${relFromSrc}.js`);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: factory() };
};

const HOUR_MS = 60 * 60 * 1000;

let verifyCalls = [];
let verifyImpl = async () => ({ valid: true });
const logs = [];

injectMock('common/audit.service', () => ({
  verifyAuditLogIntegrity: (...args) => {
    verifyCalls.push(args);
    return verifyImpl(...args);
  },
}));
injectMock('utils/logger', () => ({
  info: (...args) => logs.push(['info', ...args]),
  error: (...args) => logs.push(['error', ...args]),
}));

const { startAuditPoller } = require('../src/jobs/audit.jobs');

// Let the async sweep's pending promise callbacks settle. setImmediate is not
// mocked, so this does not advance the fake clock.
const flush = () => new Promise((resolve) => setImmediate(resolve));

let poller = null;

beforeEach(() => {
  mock.timers.enable({ apis: ['setInterval'] });
  verifyCalls = [];
  verifyImpl = async () => ({ valid: true });
  logs.length = 0;
  poller = null;
});

afterEach(() => {
  if (poller) poller.stop();
  mock.timers.reset();
});

describe('startAuditPoller — scheduling', () => {
  test('runs an integrity sweep immediately on start', () => {
    poller = startAuditPoller();

    assert.equal(verifyCalls.length, 1);
  });

  test('delegates to verifyAuditLogIntegrity with no arguments', () => {
    poller = startAuditPoller();

    assert.deepEqual(verifyCalls[0], []);
  });

  test('defaults to an hourly interval', () => {
    poller = startAuditPoller();

    mock.timers.tick(HOUR_MS - 1);
    assert.equal(verifyCalls.length, 1, 'no scheduled sweep before one hour');

    mock.timers.tick(1);
    assert.equal(verifyCalls.length, 2, 'scheduled sweep fires at one hour');

    mock.timers.tick(HOUR_MS * 3);
    assert.equal(verifyCalls.length, 5);
  });

  test('honours a custom interval', () => {
    poller = startAuditPoller({ intervalMs: 5000 });

    mock.timers.tick(4999);
    assert.equal(verifyCalls.length, 1);

    mock.timers.tick(1);
    assert.equal(verifyCalls.length, 2);

    mock.timers.tick(10000);
    assert.equal(verifyCalls.length, 4);
  });

  test('logs the start message with the effective interval', () => {
    poller = startAuditPoller({ intervalMs: 5000 });

    assert.deepEqual(logs[0], ['info', 'Audit log integrity poller started (interval: 5000ms)']);
  });

  test('logs the default interval when none is given', () => {
    poller = startAuditPoller();

    assert.deepEqual(logs[0], ['info', `Audit log integrity poller started (interval: ${HOUR_MS}ms)`]);
  });
});

describe('startAuditPoller — failure handling', () => {
  test('a rejected sweep is logged and does not stop later sweeps', async () => {
    verifyImpl = async () => {
      throw new Error('audit chain unavailable');
    };

    poller = startAuditPoller({ intervalMs: 1000 });
    await flush();

    const errors = logs.filter(([level]) => level === 'error');
    assert.deepEqual(errors, [
      ['error', 'Audit log integrity check failed to run: audit chain unavailable'],
    ]);

    verifyImpl = async () => ({ valid: true });
    mock.timers.tick(1000);
    await flush();

    assert.equal(verifyCalls.length, 2);
    assert.equal(logs.filter(([level]) => level === 'error').length, 1);
  });

  test('a successful sweep logs no errors', async () => {
    poller = startAuditPoller({ intervalMs: 1000 });
    mock.timers.tick(3000);
    await flush();

    assert.equal(verifyCalls.length, 4);
    assert.equal(logs.filter(([level]) => level === 'error').length, 0);
  });
});

describe('startAuditPoller — stop', () => {
  test('stop() cancels future sweeps and logs shutdown', () => {
    poller = startAuditPoller({ intervalMs: 1000 });
    mock.timers.tick(1000);
    assert.equal(verifyCalls.length, 2);

    poller.stop();
    poller = null;
    mock.timers.tick(10000);

    assert.equal(verifyCalls.length, 2, 'no sweeps after stop');
    assert.deepEqual(logs[logs.length - 1], ['info', 'Audit log integrity poller stopped.']);
  });

  test('independent pollers keep independent timers', () => {
    const fast = startAuditPoller({ intervalMs: 1000 });
    poller = startAuditPoller({ intervalMs: 5000 });
    assert.equal(verifyCalls.length, 2, 'each poller sweeps once on start');

    mock.timers.tick(5000);
    assert.equal(verifyCalls.length, 2 + 5 + 1);

    fast.stop();
    mock.timers.tick(5000);
    assert.equal(verifyCalls.length, 2 + 5 + 1 + 1, 'only the slow poller keeps running');
  });
});
