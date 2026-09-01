'use strict';

// Continuous alert-delivery verification (#228) — service unit tests.
// Exercises dispatch, route/fallback behaviour, delivery acknowledgement
// reconciliation, missed-test detection, idempotency/anti-storm guarantees,
// and the customer-safety invariant (synthetic messages only reach the
// internal test recipient). The SUT is dependency-injected (db/cfg/whatsapp),
// so nothing touches the network or a real database.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  dispatchSyntheticTest,
  reconcileInFlightTests,
  detectMissedVerification,
  runAlertDeliveryCycle,
  getStatus,
  testIdForEpoch,
  TEST_REFERENCE_TYPE,
  TEST_PREFIX,
} = require('../src/observability/alertDelivery.service');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RECIPIENT = '+15551234567';
const CUSTOMER = '+15550000001'; // must NEVER be used as a recipient
const NOW = new Date('2026-08-30T00:00:00.000Z');

const makeCfg = (overrides = {}) => ({
  messageTransport: 'meta',
  alertDelivery: {
    enabled: true,
    recipient: RECIPIENT,
    intervalMs: 3600000,
    ackTimeoutMs: 600000,
    missedFactor: 3,
    templateName: '',
    templateLanguage: 'en',
    ...overrides,
  },
});

// In-memory fake Prisma client supporting only what the service touches.
const makeDb = (seed = {}) => {
  const tests = [...(seed.tests || [])];
  const states = [...(seed.states || [])];
  const notifications = [...(seed.notifications || [])];
  let id = 100;
  const findTest = (pred) => tests.find(pred) || null;

  const db = {
    _tests: tests,
    _states: states,
    _notifications: notifications,
    alertDeliveryTest: {
      create: async ({ data }) => {
        if (tests.some((t) => t.testId === data.testId)) {
          const e = new Error('Unique constraint failed');
          e.code = 'P2002';
          throw e;
        }
        const row = { id: `t${id++}`, createdAt: NOW, ...data };
        tests.push(row);
        return row;
      },
      findFirst: async ({ where }) => {
        let list = tests;
        if (where.status?.in) list = list.filter((t) => where.status.in.includes(t.status));
        return list[0] || null;
      },
      findMany: async ({ where, orderBy } = {}) => {
        let list = [...tests];
        if (where?.status?.in) list = list.filter((t) => where.status.in.includes(t.status));
        if (orderBy?.attemptedAt === 'desc') list.sort((a, b) => new Date(b.attemptedAt) - new Date(a.attemptedAt));
        return list;
      },
      update: async ({ where, data }) => {
        const row = findTest((t) => t.id === where.id);
        Object.assign(row, data);
        return row;
      },
      count: async ({ where } = {}) => {
        let list = tests;
        if (where?.status?.in) list = list.filter((t) => where.status.in.includes(t.status));
        return list.length;
      },
    },
    alertDeliveryState: {
      findUnique: async ({ where }) => states.find((s) => s.id === where.id) || null,
      create: async ({ data }) => { states.push({ ...data }); return states.at(-1); },
      upsert: async ({ where, update, create }) => {
        const existing = states.find((s) => s.id === where.id);
        if (existing) Object.assign(existing, update);
        else states.push({ ...create });
        return states.find((s) => s.id === where.id);
      },
    },
    notification: {
      findFirst: async ({ where }) => (
        notifications.find((n) => n.referenceType === where.referenceType && n.referenceId === where.referenceId)
        || null
      ),
    },
  };
  return db;
};

// Fake WhatsApp transport; each send records its target so tests can assert the
// customer-safety invariant.
const makeWhatsapp = ({ textResult, templateResult } = {}) => {
  const calls = [];
  const sendTextMessage = async (to, body, opts) => {
    calls.push({ type: 'text', to, body, opts });
    return textResult || { outcome: 'accepted', providerMessageId: 'wamid-text', correlationId: opts.correlationId, attempts: 1 };
  };
  const sendTemplateMessage = async (to, templateName, lang, components, opts) => {
    calls.push({ type: 'template', to, templateName, opts });
    return templateResult === undefined
      ? { messages: [{ id: 'wamid-template' }] }
      : templateResult;
  };
  return { impl: { sendTextMessage, sendTemplateMessage, calls }, calls };
};

const stateHas = (db, key) => {
  const s = db._states.find((x) => x.id === 'main');
  return s ? s[key] : undefined;
};

// ---------------------------------------------------------------------------
// Scheduling & dispatch
// ---------------------------------------------------------------------------

describe('dispatch — scheduling, routes, anti-storm', () => {
  test('disabled when recipient unset', async () => {
    const db = makeDb();
    const result = await runAlertDeliveryCycle({ db, cfg: makeCfg({ recipient: '' }), now: NOW });
    assert.equal(result.enabled, false);
    assert.equal(result.status, 'disabled');
    assert.equal(stateHas(db, 'overallStatus'), 'disabled');
  });

  test('disabled on sim transport (no provider delivery confirmation possible)', async () => {
    const db = makeDb();
    const simCfg = { ...makeCfg(), messageTransport: 'sim' };
    const result = await runAlertDeliveryCycle({ db, cfg: simCfg, now: NOW });
    assert.equal(result.enabled, false);
  });

  test('primary route success → accepted, healthy, exactly one message to the internal recipient', async () => {
    const db = makeDb();
    const { impl, calls } = makeWhatsapp();
    const result = await dispatchSyntheticTest({ db, cfg: makeCfg(), now: NOW, whatsappImpl: impl });
    assert.equal(result.dispatched, true);
    assert.equal(result.syncOutcome, 'accepted');
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.overallStatus, 'healthy');
    assert.equal(calls.length, 1, 'only the primary route should be used on success');
    assert.equal(calls[0].to, RECIPIENT, 'synthetic message must go to the internal test recipient');
    assert.equal(calls[0].type, 'text');
    assert.match(calls[0].body, /SendAm alert-delivery test/);
    assert.match(calls[0].opts.correlationId, /synthetic-alert:/);
    const test = db._tests.find((t) => t.testId === result.testId);
    assert.equal(test.status, 'accepted');
    assert.equal(test.recipient, RECIPIENT);
    assert.equal(test.routes.length, 1);
    assert.equal(stateHas(db, 'overallStatus'), 'healthy');
    assert.ok(stateHas(db, 'lastDispatchAt'));
  });

  test('every configured route is discovered and primary failure triggers the fallback route', async () => {
    const db = makeDb();
    const { impl, calls } = makeWhatsapp({
      textResult: {
        outcome: 'permanent_failure', retryable: false,
        error: { kind: 'conversation_window', message: 'outside window', code: null, status: 400 },
      },
      templateResult: { messages: [{ id: 'wamid-template' }] },
    });
    const cfg = makeCfg({ templateName: 'sendam_alert_test' });
    const result = await dispatchSyntheticTest({ db, cfg, now: NOW, whatsappImpl: impl });
    assert.equal(result.dispatched, true);
    assert.equal(result.syncOutcome, 'accepted'); // fallback accepted
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.overallStatus, 'degraded'); // primary failure stays visible
    assert.equal(calls.length, 2, 'primary failed then fallback template attempted');
    assert.equal(calls[0].type, 'text');
    assert.equal(calls[1].type, 'template');
    assert.equal(calls[1].to, RECIPIENT);
    const test = db._tests.find((t) => t.testId === result.testId);
    assert.equal(test.fallbackUsed, true);
    assert.equal(test.routes.length, 2);
    assert.equal(test.routes[0].outcome, 'failed');
    assert.equal(test.routes[1].outcome, 'accepted');
  });

  test('primary AND fallback both fail → verification failed, bounded (no recursion)', async () => {
    const db = makeDb();
    const { impl, calls } = makeWhatsapp({
      textResult: { outcome: 'permanent_failure', retryable: false, error: { kind: 'http', message: 'down' } },
      templateResult: null, // sendTemplateMessage returns null on error
    });
    const cfg = makeCfg({ templateName: 'sendam_alert_test' });
    const result = await dispatchSyntheticTest({ db, cfg, now: NOW, whatsappImpl: impl });
    assert.equal(result.syncOutcome, 'failed');
    assert.equal(result.overallStatus, 'failed');
    assert.equal(calls.length, 2, 'exactly primary + one fallback; never recursive');
    const test = db._tests.find((t) => t.testId === result.testId);
    assert.equal(test.status, 'failed');
    assert.equal(test.failureReason, 'all_routes_failed_synchronously');
    assert.equal(stateHas(db, 'overallStatus'), 'failed');
    assert.equal(stateHas(db, 'lastFailureReason'), 'all_routes_failed_synchronously');
  });

  test('primary failure with no fallback configured → failed', async () => {
    const db = makeDb();
    const { impl, calls } = makeWhatsapp({
      textResult: { outcome: 'permanent_failure', retryable: false, error: { kind: 'http', message: 'down' } },
    });
    const result = await dispatchSyntheticTest({ db, cfg: makeCfg({ templateName: '' }), now: NOW, whatsappImpl: impl });
    assert.equal(result.syncOutcome, 'failed');
    assert.equal(result.overallStatus, 'failed');
    assert.equal(calls.length, 1, 'no fallback attempted when none is configured');
  });

  test('in-flight guard prevents a second concurrent test (anti-storm)', async () => {
    const db = makeDb({ tests: [{ id: 't1', testId: `${TEST_PREFIX}:old`, status: 'accepted', attemptedAt: NOW }] });
    const { impl, calls } = makeWhatsapp();
    const result = await dispatchSyntheticTest({ db, cfg: makeCfg(), now: NOW, whatsappImpl: impl });
    assert.equal(result.dispatched, false);
    assert.equal(result.reason, 'in_flight');
    assert.equal(calls.length, 0, 'no message sent while a test is in flight');
  });

  test('interval gate prevents dispatching more often than the configured schedule', async () => {
    const soon = new Date(NOW.getTime() - 1000);
    const db = makeDb({ states: [{ id: 'main', lastDispatchAt: soon }] });
    const { impl, calls } = makeWhatsapp();
    const result = await dispatchSyntheticTest({ db, cfg: makeCfg(), now: NOW, whatsappImpl: impl });
    assert.equal(result.dispatched, false);
    assert.equal(result.reason, 'not_due');
    assert.equal(calls.length, 0);
  });

  test('duplicate epoch collision is skipped (idempotent across scheduler replicas)', async () => {
    const db = makeDb();
    const cfg = makeCfg();
    const testId = testIdForEpoch(NOW, cfg);
    const { impl } = makeWhatsapp();
    await dispatchSyntheticTest({ db, cfg, now: NOW, whatsappImpl: impl });
    // Simulate another replica racing on the same epoch: force a P2002 by re-creating.
    const second = await dispatchSyntheticTest({ db, cfg, now: new Date(NOW.getTime() + 1), whatsappImpl: impl });
    assert.equal(testId.startsWith(TEST_PREFIX), true);
    assert.ok(['in_flight', 'duplicate', 'not_due'].includes(second.reason), `unexpected skip reason ${second.reason}`);
  });
});

// ---------------------------------------------------------------------------
// Delivery acknowledgement / confirmation reconciliation
// ---------------------------------------------------------------------------

describe('acknowledgement reconciliation', () => {
  const acceptedTest = (overrides = {}) => ({
    id: 't1',
    testId: `${TEST_PREFIX}:epoch`,
    status: 'accepted',
    recipient: RECIPIENT,
    routes: [],
    primaryRoute: 'whatsapp-text',
    fallbackUsed: false,
    syncOutcome: 'accepted',
    attemptedAt: new Date(NOW.getTime() - 60 * 1000),
    ...overrides,
  });
  const notification = (status, overrides = {}) => ({
    referenceType: TEST_REFERENCE_TYPE,
    referenceId: `${TEST_PREFIX}:epoch`,
    status,
    ...overrides,
  });

  test('delivered → confirmed end-to-end, lastSuccessfulTestAt updated, healthy', async () => {
    const db = makeDb({
      tests: [acceptedTest()],
      notifications: [notification('delivered', { deliveredAt: NOW })],
    });
    const results = await reconcileInFlightTests({ db, cfg: makeCfg(), now: NOW });
    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, 'confirmed');
    assert.equal(db._tests[0].status, 'confirmed');
    assert.equal(db._tests[0].confirmedAt.getTime(), NOW.getTime());
    assert.equal(stateHas(db, 'overallStatus'), 'healthy');
    assert.equal(stateHas(db, 'lastSuccessfulTestAt').getTime(), NOW.getTime());
  });

  test('read → confirmed; fallback-used delivery is marked degraded not healthy', async () => {
    const db = makeDb({
      tests: [acceptedTest({ fallbackUsed: true })],
      notifications: [notification('read', { readAt: NOW })],
    });
    const [result] = await reconcileInFlightTests({ db, cfg: makeCfg(), now: NOW });
    assert.equal(result.outcome, 'confirmed');
    assert.equal(result.degraded, true);
    assert.equal(stateHas(db, 'overallStatus'), 'degraded');
    assert.equal(stateHas(db, 'lastSuccessfulTestAt').getTime(), NOW.getTime());
  });

  test('provider reports failed → test failed; lastSuccessfulTestAt is NOT overwritten', async () => {
    const prior = new Date('2026-08-01T00:00:00.000Z');
    const db = makeDb({
      tests: [acceptedTest()],
      notifications: [notification('failed', { providerMessageId: 'wamid', failureMessage: 'rejected' })],
      states: [{ id: 'main', overallStatus: 'healthy', lastSuccessfulTestAt: prior }],
    });
    const results = await reconcileInFlightTests({ db, cfg: makeCfg(), now: NOW });
    assert.equal(results[0].outcome, 'failed');
    assert.equal(results[0].reason, 'provider_failed');
    assert.equal(db._tests[0].status, 'failed');
    assert.equal(stateHas(db, 'overallStatus'), 'failed');
    assert.equal(stateHas(db, 'lastSuccessfulTestAt').getTime(), prior.getTime(), 'failed verification must not clear last success');
  });

  test('acknowledgement timeout after ackTimeoutMs → timed out and actionable', async () => {
    const age = 10 * 60 * 1000 + 1; // > ackTimeoutMs (10 min)
    const db = makeDb({
      tests: [acceptedTest({ attemptedAt: new Date(NOW.getTime() - age) })],
      notifications: [notification('sent', { deliveredAt: null })], // accepted but never delivered
    });
    const [result] = await reconcileInFlightTests({ db, cfg: makeCfg({ ackTimeoutMs: 600000 }), now: NOW });
    assert.equal(result.outcome, 'timed_out');
    assert.equal(db._tests[0].status, 'timed_out');
    assert.equal(stateHas(db, 'overallStatus'), 'failed');
    assert.match(stateHas(db, 'lastFailureReason'), /acknowledgement_timeout/);
  });

  test('pending within timeout → left in flight (no premature failure)', async () => {
    const db = makeDb({
      tests: [acceptedTest()],
      notifications: [notification('sent')],
    });
    const results = await reconcileInFlightTests({ db, cfg: makeCfg(), now: NOW });
    assert.equal(results.length, 0);
    assert.equal(db._tests[0].status, 'accepted');
  });
});

// ---------------------------------------------------------------------------
// Missed-test detection
// ---------------------------------------------------------------------------

describe('missed-test detection', () => {
  test('stale last success with no in-flight test → failed/missed_test, last success preserved', async () => {
    const prior = new Date('2026-08-01T00:00:00.000Z');
    const db = makeDb({ states: [{ id: 'main', lastSuccessfulTestAt: prior, overallStatus: 'healthy' }] });
    const cfg = makeCfg({ intervalMs: 3600000, missedFactor: 3 });
    const result = await detectMissedVerification({ db, cfg, now: NOW });
    assert.ok(result.missed);
    assert.equal(stateHas(db, 'overallStatus'), 'failed');
    assert.equal(stateHas(db, 'lastFailureReason'), 'missed_test');
    assert.equal(stateHas(db, 'lastSuccessfulTestAt').getTime(), prior.getTime());
  });

  test('fresh last success → not missed', async () => {
    const recent = new Date(NOW.getTime() - 60 * 1000);
    const db = makeDb({ states: [{ id: 'main', lastSuccessfulTestAt: recent, overallStatus: 'healthy' }] });
    const result = await detectMissedVerification({ db, cfg: makeCfg({ intervalMs: 3600000, missedFactor: 3 }), now: NOW });
    assert.equal(result, null);
  });

  test('in-flight test → not flagged as missed (reconciliation owns it)', async () => {
    const prior = new Date('2026-08-01T00:00:00.000Z');
    const db = makeDb({
      states: [{ id: 'main', lastSuccessfulTestAt: prior, overallStatus: 'healthy' }],
      tests: [{ id: 't1', testId: `${TEST_PREFIX}:epoch`, status: 'accepted', attemptedAt: NOW }],
    });
    const result = await detectMissedVerification({ db, cfg: makeCfg(), now: NOW });
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Idempotency, status, customer-safety
// ---------------------------------------------------------------------------

describe('idempotency, status surface & customer safety', () => {
  test('failed run never overwrites lastSuccessfulTestAt during dispatch', async () => {
    const prior = new Date('2026-08-01T00:00:00.000Z');
    const db = makeDb({ states: [{ id: 'main', lastSuccessfulTestAt: prior, overallStatus: 'healthy' }] });
    const { impl } = makeWhatsapp({
      textResult: { outcome: 'permanent_failure', retryable: false, error: { kind: 'http', message: 'down' } },
    });
    await dispatchSyntheticTest({ db, cfg: makeCfg({ templateName: '' }), now: NOW, whatsappImpl: impl });
    assert.equal(stateHas(db, 'overallStatus'), 'failed');
    assert.equal(stateHas(db, 'lastSuccessfulTestAt').getTime(), prior.getTime());
    assert.ok(stateHas(db, 'lastFailureAt'));
  });

  test('synthetic alerts can never target a customer number', async () => {
    const db = makeDb();
    const { impl, calls } = makeWhatsapp();
    // Reconfigure with a recipient that differs from customers; assert only it is used.
    const cfg = makeCfg();
    await dispatchSyntheticTest({ db, cfg, now: NOW, whatsappImpl: impl });
    for (const call of calls) {
      assert.equal(call.to, RECIPIENT, 'every synthetic send goes to the internal recipient');
      assert.notEqual(call.to, CUSTOMER);
    }
    const test = db._tests[0];
    // Marked unmistakably as a synthetic test in the persisted reference.
    assert.equal(test.status, 'accepted');
    assert.ok(db._tests.every((t) => t.testId.startsWith(TEST_PREFIX)));
  });

  test('getStatus returns diagnostics without recipients or secrets', async () => {
    const db = makeDb({
      states: [{ id: 'main', overallStatus: 'healthy', lastSuccessfulTestAt: NOW, lastTestId: `${TEST_PREFIX}:epoch` }],
      tests: [{ id: 't1', testId: `${TEST_PREFIX}:epoch`, status: 'confirmed', recipient: RECIPIENT, routes: [], attemptedAt: NOW }],
    });
    const status = await getStatus({ db, cfg: makeCfg() });
    assert.equal(status.overallStatus, 'healthy');
    assert.equal(status.enabled, true);
    assert.equal(status.lastTestId, `${TEST_PREFIX}:epoch`);
    assert.equal(status.lastSuccessfulTestAt.getTime(), NOW.getTime());
    assert.equal(status.recentTests.length, 1);
    const json = JSON.stringify(status);
    assert.equal(json.includes(RECIPIENT), false, 'status must not leak the recipient');
  });

  test('full enabled cycle returns healthy summary after a fresh dispatch', async () => {
    const db = makeDb();
    const { impl } = makeWhatsapp();
    const result = await runAlertDeliveryCycle({ db, cfg: makeCfg(), now: NOW, whatsappImpl: impl });
    assert.equal(result.enabled, true);
    assert.equal(result.status, 'healthy');
    assert.ok(result.dispatched.dispatched);
    assert.equal(result.dispatched.syncOutcome, 'accepted');
  });
});