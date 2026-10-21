'use strict';

// Verification expiry poller unit tests — #445
//
// Covers src/jobs/verification.expiry.jobs.js: the poller runs the expiry
// sweep immediately, re-runs it on the configured interval, logs a summary
// only when the sweep did something, survives sweep failures, and stops
// cleanly.
//
// The real compliance/verification.expiry module is loaded underneath the
// job, with a mocked Prisma client below it, so delegation is observed at
// the Prisma boundary. setInterval is driven by node:test mock timers, so no
// real time passes.

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const injectMock = (relFromSrc, factory) => {
  const abs = path.resolve(__dirname, '../src', `${relFromSrc}.js`);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: factory() };
};

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

let findManyCalls = 0;
let profilesToReturn = [];
let findManyError = null;
const notifications = [];
const logs = [];

injectMock('common/prisma', () => ({
  kycProfile: {
    findMany: async () => {
      findManyCalls++;
      if (findManyError) throw findManyError;
      return profilesToReturn;
    },
    update: async (args) => ({ id: args.where.id, ...args.data }),
  },
  notification: {
    create: async (args) => {
      notifications.push(args.data);
      return { id: `notif_${notifications.length}`, ...args.data };
    },
  },
  user: {
    update: async (args) => ({ id: args.where.id, ...args.data }),
  },
}));
injectMock('common/audit.service', () => ({
  writeAuditLog: async () => ({ id: 'audit_1' }),
}));
injectMock('utils/logger', () => ({
  info: (...args) => logs.push(['info', ...args]),
  warn: (...args) => logs.push(['warn', ...args]),
  error: (...args) => logs.push(['error', ...args]),
}));

// Shared config object: the job reads compliance.expiryIntervalMs at start
// time, so tests can adjust it per case.
const config = { compliance: {} };
injectMock('config/env', () => config);

const { startVerificationExpiryPoller } = require('../src/jobs/verification.expiry.jobs');

// Let the async sweep's promise chain settle. setImmediate is not mocked, so
// this does not advance the fake clock.
const flush = () => new Promise((resolve) => setImmediate(resolve));

const logsFor = (event) => logs.filter(([, name]) => name === event);

// An approved profile that has never been sanctions-screened: the sweep
// queues exactly one expired_sanctions reminder for it.
const dueProfile = () => ({
  id: 'kyc_due',
  status: 'approved',
  sanctionsStatus: 'clear',
  lastScreenedAt: null,
  updatedAt: new Date(),
  metadata: {},
  user: { id: 'user_1', phoneNumber: '+2349000000001', kycTier: 1, anonymizedAt: null },
});

let poller = null;

beforeEach(() => {
  mock.timers.enable({ apis: ['setInterval'] });
  findManyCalls = 0;
  profilesToReturn = [];
  findManyError = null;
  notifications.length = 0;
  logs.length = 0;
  config.compliance = {};
  poller = null;
});

afterEach(() => {
  if (poller) poller.stop();
  mock.timers.reset();
});

describe('startVerificationExpiryPoller — scheduling', () => {
  test('runs a sweep immediately on start', async () => {
    poller = startVerificationExpiryPoller();
    await flush();

    assert.equal(findManyCalls, 1);
  });

  test('defaults to a six-hour interval', async () => {
    poller = startVerificationExpiryPoller();
    await flush();

    mock.timers.tick(SIX_HOURS_MS - 1);
    await flush();
    assert.equal(findManyCalls, 1, 'no scheduled sweep before six hours');

    mock.timers.tick(1);
    await flush();
    assert.equal(findManyCalls, 2, 'scheduled sweep fires at six hours');

    mock.timers.tick(SIX_HOURS_MS * 2);
    await flush();
    assert.equal(findManyCalls, 4);

    assert.deepEqual(logsFor('verification_expiry_poller_started')[0][2], { intervalMs: SIX_HOURS_MS });
  });

  test('uses compliance.expiryIntervalMs from config when no option is given', async () => {
    config.compliance = { expiryIntervalMs: '60000' };

    poller = startVerificationExpiryPoller();
    await flush();

    mock.timers.tick(60000);
    await flush();
    assert.equal(findManyCalls, 2);
    assert.deepEqual(logsFor('verification_expiry_poller_started')[0][2], { intervalMs: 60000 });
  });

  test('an explicit intervalMs option takes precedence over config', async () => {
    config.compliance = { expiryIntervalMs: 60000 };

    poller = startVerificationExpiryPoller({ intervalMs: 1000 });
    await flush();

    mock.timers.tick(3000);
    await flush();
    assert.equal(findManyCalls, 4);
    assert.deepEqual(logsFor('verification_expiry_poller_started')[0][2], { intervalMs: 1000 });
  });

  test('stop() cancels future sweeps and logs shutdown', async () => {
    poller = startVerificationExpiryPoller({ intervalMs: 1000 });
    mock.timers.tick(1000);
    await flush();
    assert.equal(findManyCalls, 2);

    poller.stop();
    poller = null;
    mock.timers.tick(10000);
    await flush();

    assert.equal(findManyCalls, 2, 'no sweeps after stop');
    assert.equal(logsFor('verification_expiry_poller_stopped').length, 1);
  });
});

describe('startVerificationExpiryPoller — delegation to the expiry sweep', () => {
  test('each tick runs the real sweep against Prisma and queues due reminders', async () => {
    profilesToReturn = [dueProfile()];

    poller = startVerificationExpiryPoller({ intervalMs: 1000 });
    await flush();

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].type, 'verification_reminder.expired_sanctions');
    assert.equal(notifications[0].referenceId, 'kyc_due');
    assert.equal(logsFor('verification_expiry_sweep_complete').length, 1);

    mock.timers.tick(1000);
    await flush();

    assert.equal(findManyCalls, 2);
    assert.equal(logsFor('verification_expiry_sweep_complete').length, 2);
  });

  test('logs a summary when the sweep sent reminders', async () => {
    profilesToReturn = [dueProfile()];

    poller = startVerificationExpiryPoller();
    await flush();

    const summaries = logsFor('verification_expiry_sweep_summary');
    assert.equal(summaries.length, 1);
    assert.deepEqual(summaries[0][2], { reminders: 1, escalations: 0, errors: 0 });
  });

  test('does not log a summary when the sweep had nothing to do', async () => {
    profilesToReturn = [];

    poller = startVerificationExpiryPoller();
    await flush();

    assert.equal(findManyCalls, 1);
    assert.equal(logsFor('verification_expiry_sweep_summary').length, 0);
  });

  test('a failed sweep is logged and later sweeps still run', async () => {
    findManyError = new Error('database unavailable');

    poller = startVerificationExpiryPoller({ intervalMs: 1000 });
    await flush();

    assert.deepEqual(logsFor('verification_expiry_poller_error'), [
      ['error', 'verification_expiry_poller_error', { error: 'database unavailable' }],
    ]);

    findManyError = null;
    profilesToReturn = [dueProfile()];
    mock.timers.tick(1000);
    await flush();

    assert.equal(findManyCalls, 2);
    assert.equal(notifications.length, 1);
    assert.equal(logsFor('verification_expiry_poller_error').length, 1);
  });
});
