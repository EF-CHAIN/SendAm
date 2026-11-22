const { test } = require('node:test');
const assert = require('node:assert/strict');
const rp = require('../src/payment/recurringPayments');

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };
const NOW = new Date('2026-11-21T10:00:00.000Z');
const DEST = 'GDESTINATIONADDRESS000000000000000000000000000000000000';

const matches = (row, where = {}) => Object.entries(where).every(([key, cond]) => {
  if (key === 'OR') return cond.some((sub) => matches(row, sub));
  const value = row[key];
  if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
    if ('in' in cond) return cond.in.includes(value);
    if ('not' in cond) return !(value === cond.not || (value instanceof Date && cond.not instanceof Date && value.getTime() === cond.not.getTime()));
    if ('lte' in cond || 'gt' in cond) {
      if (value == null) return false;
      return (!('lte' in cond) || value <= cond.lte) && (!('gt' in cond) || value > cond.gt);
    }
  }
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  return value === cond;
});

const makeDb = (rows = [], users = { u1: { id: 'u1', phoneNumber: '+2348000000001' } }) => {
  let counter = rows.length;
  const db = {
    rows,
    recurringPayment: {
      count: async ({ where }) => rows.filter((r) => matches(r, where)).length,
      create: async ({ data }) => {
        counter += 1;
        const row = { id: `m${counter}`, failureCount: 0, reminderSentFor: null, createdAt: new Date(NOW.getTime() + counter), ...data };
        rows.push(row);
        return row;
      },
      findFirst: async ({ where }) => rows.filter((r) => matches(r, where)).sort((a, b) => b.createdAt - a.createdAt)[0] || null,
      findUnique: async ({ where }) => {
        const { userId, reference } = where.userId_reference;
        return rows.find((r) => r.userId === userId && r.reference === reference) || null;
      },
      findMany: async ({ where, take }) => rows.filter((r) => matches(r, where)).slice(0, take).map((r) => ({ ...r, user: users[r.userId] })),
      updateMany: async ({ where, data }) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
    },
  };
  return db;
};

const mandate = (overrides = {}) => ({
  id: 'm1', userId: 'u1', reference: 'ABC123', destination: DEST, amount: '10.0000000', asset: 'XLM',
  frequency: 'weekly', status: 'active', nextRunAt: new Date('2026-11-21T09:00:00.000Z'), anchorDay: 21,
  reminderSentFor: null, failureCount: 0, createdAt: NOW, ...overrides,
});

test('computeNextRun handles daily, weekly and month-end clamping without drift', () => {
  assert.equal(rp.computeNextRun(new Date('2026-11-21T09:00:00Z'), 'daily').toISOString(), '2026-11-22T09:00:00.000Z');
  assert.equal(rp.computeNextRun(new Date('2026-11-21T09:00:00Z'), 'weekly').toISOString(), '2026-11-28T09:00:00.000Z');
  const jan = rp.computeNextRun(new Date('2026-01-31T09:00:00Z'), 'monthly', 31);
  assert.equal(jan.toISOString(), '2026-02-28T09:00:00.000Z');
  assert.equal(rp.computeNextRun(jan, 'monthly', 31).toISOString(), '2026-03-31T09:00:00.000Z');
  assert.equal(rp.computeNextRun(new Date('2026-12-15T09:00:00Z'), 'monthly', 15).toISOString(), '2027-01-15T09:00:00.000Z');
  assert.throws(() => rp.computeNextRun(NOW, 'hourly'), /Unsupported/);
});

test('nextRunAfter skips missed occurrences instead of bursting', () => {
  const next = rp.nextRunAfter(new Date('2026-11-01T09:00:00Z'), 'daily', 1, NOW);
  assert.equal(next.toISOString(), '2026-11-22T09:00:00.000Z');
});

test('parseRecurringCommand understands schedule, manage and list commands', () => {
  assert.deepEqual(rp.parseRecurringCommand(`repeat 10 xlm to ${DEST} weekly`), {
    kind: 'schedule', amount: '10', asset: 'XLM', destination: DEST, frequency: 'weekly', startDate: null,
  });
  assert.equal(rp.parseRecurringCommand(`schedule 2.5 to ${DEST} every month starting 2026-12-01`).startDate, '2026-12-01');
  assert.equal(rp.parseRecurringCommand(`autopay 1 usdc to ${DEST} every day`).frequency, 'daily');
  assert.deepEqual(rp.parseRecurringCommand('pause abc123'), { kind: 'manage', action: 'pause', reference: 'ABC123' });
  assert.equal(rp.parseRecurringCommand('stop ABC123').action, 'cancel');
  assert.deepEqual(rp.parseRecurringCommand('recurring list'), { kind: 'list' });
  assert.equal(rp.parseRecurringCommand('send 10 to G123'), null);
  assert.equal(rp.parseRecurringCommand('cancel'), null);
});

test('a schedule request is stored awaiting PIN and moves no money', async () => {
  const db = makeDb();
  const created = await rp.requestRecurringPayment({
    prisma: db, user: { id: 'u1' }, now: NOW, validateAddress: () => true,
    intent: { amount: '5', asset: 'XLM', destination: DEST, frequency: 'weekly' },
  });
  assert.equal(created.status, 'awaiting_pin');
  assert.equal(created.amount, '5.0000000');
  assert.equal(created.nextRunAt.toISOString(), '2026-11-22T10:00:00.000Z');
  assert.ok(created.expiresAt > NOW);
  assert.match(created.reference, /^[0-9A-F]{6}$/);
});

test('request validation rejects bad frequency, amount, destination and past start dates', async () => {
  const base = { prisma: makeDb(), user: { id: 'u1' }, now: NOW, validateAddress: () => true };
  const intent = { amount: '5', asset: 'XLM', destination: DEST, frequency: 'weekly' };
  await assert.rejects(rp.requestRecurringPayment({ ...base, intent: { ...intent, frequency: 'hourly' } }), /Frequency/);
  await assert.rejects(rp.requestRecurringPayment({ ...base, intent: { ...intent, amount: '1.12345678' } }), /decimal places/);
  await assert.rejects(rp.requestRecurringPayment({ ...base, validateAddress: () => false, intent }), /valid Stellar address/);
  await assert.rejects(rp.requestRecurringPayment({ ...base, intent: { ...intent, startDate: '2026-11-01' } }), /future/);
  await assert.rejects(rp.requestRecurringPayment({ ...base, intent: { ...intent, startDate: '2026-02-31' } }), /valid date/);
});

test('a newer unconfirmed request supersedes the older one', async () => {
  const db = makeDb();
  const args = { prisma: db, user: { id: 'u1' }, now: NOW, validateAddress: () => true, intent: { amount: '5', asset: 'XLM', destination: DEST, frequency: 'daily' } };
  const first = await rp.requestRecurringPayment(args);
  await rp.requestRecurringPayment(args);
  assert.equal(db.rows.find((r) => r.id === first.id).status, 'cancelled');
  assert.equal(db.rows.filter((r) => r.status === 'awaiting_pin').length, 1);
});

test('PIN confirmation activates only on a correct PIN', async () => {
  const db = makeDb([mandate({ status: 'awaiting_pin', expiresAt: new Date(NOW.getTime() + 60000) })]);
  const run = (verdict) => rp.confirmWithPin({ prisma: db, user: { id: 'u1' }, pin: '1234', now: NOW, verifyPinAttempt: async () => verdict });

  assert.equal((await run({ ok: false, locked: false })).status, 'bad_pin');
  assert.equal(db.rows[0].status, 'awaiting_pin');
  assert.deepEqual(await run({ ok: false, locked: true, retryAfterMs: 5000 }), { status: 'locked', retryAfterMs: 5000 });
  const ok = await run({ ok: true });
  assert.equal(ok.status, 'activated');
  assert.equal(db.rows[0].status, 'active');
  assert.equal(db.rows[0].pinConfirmedAt, NOW);
  assert.equal((await run({ ok: true })).status, 'none');
});

test('expired confirmations are cancelled without checking the PIN', async () => {
  const db = makeDb([mandate({ status: 'awaiting_pin', expiresAt: new Date(NOW.getTime() - 1) })]);
  let checked = false;
  const result = await rp.confirmWithPin({
    prisma: db, user: { id: 'u1' }, pin: '1234', now: NOW, verifyPinAttempt: async () => { checked = true; return { ok: true }; },
  });
  assert.equal(result.status, 'expired');
  assert.equal(checked, false);
  assert.equal(db.rows[0].status, 'cancelled');
});

test('reminders go out once, 24h before the run, and only for active mandates', async () => {
  const soon = mandate({ id: 'soon', nextRunAt: new Date(NOW.getTime() + 23 * 3600 * 1000) });
  const far = mandate({ id: 'far', reference: 'FAR111', nextRunAt: new Date(NOW.getTime() + 49 * 3600 * 1000) });
  const paused = mandate({ id: 'paused', reference: 'PAU111', status: 'paused', nextRunAt: new Date(NOW.getTime() + 3600 * 1000) });
  const db = makeDb([soon, far, paused]);
  const sent = [];
  const notify = async (to, body) => sent.push({ to, body });

  assert.deepEqual(await rp.sendUpcomingReminders({ prisma: db, notify, now: NOW, log: silentLog }), { sent: 1 });
  assert.match(sent[0].body, /pause ABC123/);
  assert.match(sent[0].body, /cancel ABC123/);
  assert.deepEqual(await rp.sendUpcomingReminders({ prisma: db, notify, now: NOW, log: silentLog }), { sent: 0 });
  assert.equal(sent.length, 1);
});

test('a failed reminder is released so the next tick retries it', async () => {
  const db = makeDb([mandate({ nextRunAt: new Date(NOW.getTime() + 3600 * 1000) })]);
  await rp.sendUpcomingReminders({ prisma: db, notify: async () => { throw new Error('down'); }, now: NOW, log: silentLog });
  assert.equal(db.rows[0].reminderSentFor, null);
  const sent = [];
  await rp.sendUpcomingReminders({ prisma: db, notify: async (...a) => sent.push(a), now: NOW, log: silentLog });
  assert.equal(sent.length, 1);
});

test('a due mandate executes once with a per-occurrence idempotency key and advances', async () => {
  const db = makeDb([mandate()]);
  const calls = [];
  const execute = async (args) => { calls.push(args); return { transaction: { id: 'tx9' } }; };
  const sent = [];
  const notify = async (to, body) => sent.push(body);

  const first = await rp.runDueRecurringPayments({ prisma: db, execute, notify, now: NOW, log: silentLog });
  assert.deepEqual(first, { executed: 1, failed: 0, skipped: 0 });
  assert.equal(calls[0].amount, '10.0000000');
  assert.equal(calls[0].destination, DEST);
  assert.equal(calls[0].idempotencyKey, 'recurring:m1:2026-11-21T09:00:00.000Z');
  assert.equal(db.rows[0].nextRunAt.toISOString(), '2026-11-28T09:00:00.000Z');
  assert.equal(db.rows[0].lastTransactionId, 'tx9');
  assert.match(sent[0], /Recurring payment sent/);

  const second = await rp.runDueRecurringPayments({ prisma: db, execute, notify, now: NOW, log: silentLog });
  assert.deepEqual(second, { executed: 0, failed: 0, skipped: 0 });
  assert.equal(calls.length, 1);
});

test('paused, cancelled and not-yet-due mandates never execute', async () => {
  const db = makeDb([
    mandate({ id: 'a', reference: 'AAA111', status: 'paused' }),
    mandate({ id: 'b', reference: 'BBB111', status: 'cancelled' }),
    mandate({ id: 'c', reference: 'CCC111', nextRunAt: new Date(NOW.getTime() + 1000) }),
  ]);
  let calls = 0;
  await rp.runDueRecurringPayments({ prisma: db, execute: async () => { calls += 1; }, notify: async () => {}, now: NOW, log: silentLog });
  assert.equal(calls, 0);
});

test('a pause that lands after the due query but before the claim prevents the run', async () => {
  const db = makeDb([mandate()]);
  const originalFindMany = db.recurringPayment.findMany;
  db.recurringPayment.findMany = async (args) => {
    const rows = await originalFindMany(args);
    db.rows[0].status = 'paused';
    return rows;
  };
  let calls = 0;
  const summary = await rp.runDueRecurringPayments({ prisma: db, execute: async () => { calls += 1; }, notify: async () => {}, now: NOW, log: silentLog });
  assert.equal(calls, 0);
  assert.equal(summary.skipped, 1);
});

test('failures are reported and three in a row auto-pause the mandate', async () => {
  const db = makeDb([mandate({ failureCount: 2 })]);
  const sent = [];
  const summary = await rp.runDueRecurringPayments({
    prisma: db, execute: async () => { throw new Error('insufficient balance'); }, notify: async (to, body) => sent.push(body), now: NOW, log: silentLog,
  });
  assert.equal(summary.failed, 1);
  assert.equal(db.rows[0].status, 'paused');
  assert.equal(db.rows[0].failureCount, rp.MAX_CONSECUTIVE_FAILURES);
  assert.match(sent[0], /insufficient balance/);
  assert.match(sent[0], /resume ABC123/);
});

test('a notification failure after a successful payment does not break the run', async () => {
  const db = makeDb([mandate()]);
  const summary = await rp.runDueRecurringPayments({
    prisma: db, execute: async () => ({ transaction: { id: 't' } }), notify: async () => { throw new Error('wa down'); }, now: NOW, log: silentLog,
  });
  assert.equal(summary.executed, 1);
});

test('after downtime only one catch-up run happens and the schedule resumes in the future', async () => {
  const db = makeDb([mandate({ frequency: 'daily', nextRunAt: new Date('2026-11-10T09:00:00Z') })]);
  let calls = 0;
  await rp.runDueRecurringPayments({ prisma: db, execute: async () => { calls += 1; return {}; }, notify: async () => {}, now: NOW, log: silentLog });
  assert.equal(calls, 1);
  assert.ok(db.rows[0].nextRunAt > NOW);
});

test('pause, resume and cancel follow the allowed transitions', async () => {
  const db = makeDb([mandate()]);
  const change = (action, now = NOW) => rp.changeStatus({ prisma: db, userId: 'u1', reference: 'abc123', action, now });

  assert.equal((await change('pause')).changed, true);
  assert.equal(db.rows[0].status, 'paused');
  assert.equal((await change('pause')).changed, false);
  const resumed = await change('resume');
  assert.equal(resumed.changed, true);
  assert.equal(db.rows[0].status, 'active');
  assert.ok(db.rows[0].nextRunAt > NOW, 'resume must not fire an overdue run immediately');
  assert.equal((await change('cancel')).changed, true);
  assert.equal((await change('resume')).changed, false);
  assert.equal(await rp.changeStatus({ prisma: db, userId: 'u1', reference: 'NOPE00', action: 'pause' }), null);
  assert.equal(await rp.changeStatus({ prisma: db, userId: 'other', reference: 'ABC123', action: 'pause' }), null);
  await assert.rejects(change('explode'), /Unsupported action/);
});

test('WhatsApp flow: schedule, then PIN activates, then list and pause', async () => {
  const db = makeDb();
  const sent = [];
  const notify = async (to, body) => sent.push(body);
  const user = { id: 'u1' };
  const deps = { validateAddress: () => true, now: NOW, verifyPinAttempt: async () => ({ ok: true }) };
  const send = (text, extra = {}) => rp.handleRecurringMessage({
    phoneNumber: '+2348000000001', user, text, notify, prisma: db, deps, ...extra,
  });

  assert.equal(await send(`repeat 10 XLM to ${DEST} weekly`), true);
  assert.match(sent.at(-1), /Reply with your PIN/);
  assert.equal(db.rows[0].status, 'awaiting_pin');

  assert.equal(await send('1234'), true);
  assert.match(sent.at(-1), /is active/);
  assert.equal(db.rows[0].status, 'active');

  assert.equal(await send('recurring list'), true);
  assert.match(sent.at(-1), new RegExp(db.rows[0].reference));

  assert.equal(await send(`pause ${db.rows[0].reference}`), true);
  assert.match(sent.at(-1), /paused/);
});

test('WhatsApp flow: PIN-like replies fall through when nothing is pending or a send is pending', async () => {
  const db = makeDb();
  const notify = async () => assert.fail('should not notify');
  const base = { phoneNumber: 'x', user: { id: 'u1' }, notify, prisma: db, deps: { verifyPinAttempt: async () => ({ ok: true }) } };
  assert.equal(await rp.handleRecurringMessage({ ...base, text: '1234' }), false);

  db.rows.push(mandate({ status: 'awaiting_pin', expiresAt: new Date(NOW.getTime() + 60000) }));
  assert.equal(await rp.handleRecurringMessage({ ...base, text: '1234', hasPendingSend: true }), false);
  assert.equal(db.rows[0].status, 'awaiting_pin');
  assert.equal(await rp.handleRecurringMessage({ ...base, text: 'hello there' }), false);
});

test('WhatsApp flow: invalid requests and unknown references produce clear replies', async () => {
  const db = makeDb();
  const sent = [];
  const notify = async (to, body) => sent.push(body);
  const args = { phoneNumber: 'x', user: { id: 'u1' }, notify, prisma: db, deps: { validateAddress: () => false } };
  assert.equal(await rp.handleRecurringMessage({ ...args, text: `repeat 10 XLM to ${DEST} weekly` }), true);
  assert.match(sent.at(-1), /Could not set up/);
  assert.equal(await rp.handleRecurringMessage({ ...args, text: 'cancel ZZZ999' }), true);
  assert.match(sent.at(-1), /No recurring payment found/);
});

test('scheduler tick runs reminders and execution and never overlaps itself', async () => {
  let active = 0;
  let maxActive = 0;
  let runs = 0;
  const scheduler = rp.startRecurringPaymentScheduler({
    intervalMs: 3600000,
    log: silentLog,
    run: async () => {
      active += 1; maxActive = Math.max(maxActive, active); runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    },
  });
  await Promise.all([scheduler.tick(), scheduler.tick()]);
  assert.equal(maxActive, 1);
  assert.equal(runs, 1);
  scheduler.stop();

  const failing = rp.startRecurringPaymentScheduler({ intervalMs: 3600000, log: silentLog, run: async () => { throw new Error('x'); } });
  await failing.tick();
  failing.stop();
});
