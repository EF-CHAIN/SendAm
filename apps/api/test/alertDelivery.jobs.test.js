'use strict';

// Alert-delivery verification poller (#228) — lifecycle tests.
// Verifies that the worker poller honours the enabled state and wires the
// verification cycle, without touching Redis, Postgres, or the network. The
// service is stubbed after config/prisma are injected.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const injectMock = (relFromSrc, factory) => {
  const abs = path.resolve(__dirname, '../src', `${relFromSrc}.js`);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: factory() };
};

const makeConfig = (overrides = {}) => ({
  env: 'test',
  isProduction: false,
  messageTransport: 'meta',
  alertDelivery: {
    enabled: true,
    recipient: '+15551234567',
    intervalMs: 3600000,
    ...overrides,
  },
});

describe('alert delivery poller', () => {
  test('disabled configuration → safe no-op poller', () => {
    injectMock('config/env', () => makeConfig({ enabled: false }));
    injectMock('common/prisma', () => ({}));
    const { startAlertDeliveryPoller } = require('../src/jobs/alertDelivery.jobs');
    const poller = startAlertDeliveryPoller();
    assert.equal(poller.started, false);
    assert.equal(typeof poller.stop, 'function');
    poller.stop(); // no-op must not throw
  });

  test('enabled configuration → starts and runs the verification cycle', async () => {
    let cycleCalls = 0;
    injectMock('config/env', () => makeConfig());
    injectMock('common/prisma', () => ({}));
    injectMock('observability/alertDelivery.service', () => ({
      isEnabled: () => true,
      runAlertDeliveryCycle: async () => {
        cycleCalls += 1;
        return { enabled: true, status: 'healthy', dispatched: { dispatched: true, testId: 'synthetic-alert:x' } };
      },
    }));

    // Re-require with fresh cache after injecting stubs.
    delete require.cache[require.resolve('../src/jobs/alertDelivery.jobs')];
    const { startAlertDeliveryPoller } = require('../src/jobs/alertDelivery.jobs');
    const poller = startAlertDeliveryPoller({ intervalMs: 60000 });
    assert.equal(poller.started, true);
    // The immediate first tick runs the cycle (await a macrotask so the async
    // tick from startAlertDeliveryPoller settles).
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(cycleCalls >= 1, 'verification cycle should run on start');
    poller.stop();
  });

  test('enabled configuration where cycle throws → poller still starts, error is contained', async () => {
    injectMock('config/env', () => makeConfig());
    injectMock('common/prisma', () => ({}));
    injectMock('observability/alertDelivery.service', () => ({
      isEnabled: () => true,
      runAlertDeliveryCycle: async () => { throw new Error('boom'); },
    }));
    delete require.cache[require.resolve('../src/jobs/alertDelivery.jobs')];
    const { startAlertDeliveryPoller } = require('../src/jobs/alertDelivery.jobs');
    const poller = startAlertDeliveryPoller({ intervalMs: 60000 });
    assert.equal(poller.started, true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    poller.stop();
  });
});