'use strict';

// Scheduled and recurring payment mandates (#1005).
//
// Lifecycle: a user asks for a schedule over WhatsApp, the mandate is stored as
// `awaiting_pin`, and only a correct PIN reply activates it. The worker then
//   * reminds the user 24h before each run (reply "pause <ref>" / "cancel <ref>"),
//   * executes each due occurrence exactly once.
//
// "Exactly once" comes from claiming an occurrence by advancing `nextRunAt`
// with a compare-and-set update before any money moves, plus a deterministic
// idempotency key per occurrence. A pause or cancel that lands between the
// reminder and the run is honoured because the claim requires status=active.

const crypto = require('crypto');
const logger = require('../utils/logger');
const { assertValidAmount } = require('../utils/money');

const FREQUENCIES = Object.freeze(['daily', 'weekly', 'monthly']);
const DAY_MS = 24 * 60 * 60 * 1000;
const PIN_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const REMINDER_LEAD_MS = DAY_MS;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_MANDATES_PER_USER = 20;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_INTERVAL_MS = 60 * 1000;
const START_HOUR_UTC = 9;
const REFERENCE_RETRIES = 5;

const FREQUENCY_ALIASES = Object.freeze({
  day: 'daily', daily: 'daily', week: 'weekly', weekly: 'weekly', month: 'monthly', monthly: 'monthly',
});

const lazy = {
  prisma: () => require('../common/prisma'),
  notify: () => require('../services/whatsapp.service').sendTextMessage,
  execute: () => require('./payment.orchestrator').executePayment,
  validateAddress: () => require('../wallet/stellar.adapter').validateAddress,
  verifyPinAttempt: () => require('../compliance/pin.service').verifyPinAttempt,
};

const daysInUtcMonth = (year, month) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/** The occurrence one period after `from`; monthly runs clamp to the month length. */
const computeNextRun = (from, frequency, anchorDay = from.getUTCDate()) => {
  const base = new Date(from.getTime());
  if (frequency === 'daily') return new Date(base.getTime() + DAY_MS);
  if (frequency === 'weekly') return new Date(base.getTime() + 7 * DAY_MS);
  if (frequency === 'monthly') {
    const year = base.getUTCFullYear();
    const month = base.getUTCMonth() + 1;
    const targetYear = year + Math.floor(month / 12);
    const targetMonth = month % 12;
    const day = Math.min(anchorDay, daysInUtcMonth(targetYear, targetMonth));
    return new Date(Date.UTC(
      targetYear, targetMonth, day, base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds(),
    ));
  }
  throw new Error(`Unsupported frequency: ${frequency}`);
};

/** Advance until the result is in the future so downtime never causes a burst of catch-up runs. */
const nextRunAfter = (from, frequency, anchorDay, now) => {
  let next = computeNextRun(from, frequency, anchorDay);
  while (next <= now) next = computeNextRun(next, frequency, anchorDay);
  return next;
};

const SCHEDULE_RE = /^(?:repeat|schedule|autopay|recurring)\s+(?:send\s+)?(\d+(?:\.\d+)?)\s*([a-z]{2,12})?\s+to\s+(\S+)\s+(?:every\s+)?(daily|weekly|monthly|day|week|month)(?:\s+starting\s+(\d{4}-\d{2}-\d{2}))?\s*$/i;
const MANAGE_RE = /^(?:recurring\s+)?(pause|resume|cancel|stop)\s+([a-z0-9]{6})$/i;
const LIST_RE = /^(?:recurring|schedules?)(?:\s+list)?$/i;

/** Returns a structured intent, or null when the text is not a recurring-payment command. */
const parseRecurringCommand = (text) => {
  const raw = String(text || '').trim();
  const schedule = raw.match(SCHEDULE_RE);
  if (schedule) {
    return {
      kind: 'schedule',
      amount: schedule[1],
      asset: (schedule[2] || 'XLM').toUpperCase(),
      destination: schedule[3],
      frequency: FREQUENCY_ALIASES[schedule[4].toLowerCase()],
      startDate: schedule[5] || null,
    };
  }
  const manage = raw.match(MANAGE_RE);
  if (manage) {
    const verb = manage[1].toLowerCase();
    return { kind: 'manage', action: verb === 'stop' ? 'cancel' : verb, reference: manage[2].toUpperCase() };
  }
  if (LIST_RE.test(raw)) return { kind: 'list' };
  return null;
};

const parseStartDate = (value, now) => {
  const date = new Date(`${value}T${String(START_HOUR_UTC).padStart(2, '0')}:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('Start date must be a valid date in YYYY-MM-DD format.');
  }
  if (date <= now) throw new Error('Start date must be in the future.');
  return date;
};

const makeReference = () => crypto.randomBytes(3).toString('hex').toUpperCase();

/**
 * Stores a schedule request as `awaiting_pin`. No money can move until
 * confirmWithPin() succeeds. A newer request supersedes an older unconfirmed one.
 */
const requestRecurringPayment = async ({
  prisma = lazy.prisma(),
  user,
  intent,
  now = new Date(),
  validateAddress = lazy.validateAddress(),
}) => {
  if (!user?.id) throw new Error('Sender not found.');
  if (!FREQUENCIES.includes(intent.frequency)) throw new Error('Frequency must be daily, weekly or monthly.');
  const amount = assertValidAmount(intent.amount, intent.asset);
  if (!validateAddress(String(intent.destination).trim())) {
    throw new Error('Destination must be a valid Stellar address.');
  }
  const firstRun = intent.startDate
    ? parseStartDate(intent.startDate, now)
    : computeNextRun(now, 'daily');

  const open = await prisma.recurringPayment.count({
    where: { userId: user.id, status: { in: ['active', 'paused'] } },
  });
  if (open >= MAX_MANDATES_PER_USER) {
    throw new Error(`You can have at most ${MAX_MANDATES_PER_USER} recurring payments. Cancel one first.`);
  }

  await prisma.recurringPayment.updateMany({
    where: { userId: user.id, status: 'awaiting_pin' },
    data: { status: 'cancelled' },
  });

  for (let attempt = 0; attempt < REFERENCE_RETRIES; attempt += 1) {
    try {
      return await prisma.recurringPayment.create({
        data: {
          userId: user.id,
          reference: makeReference(),
          destination: String(intent.destination).trim(),
          recipientLabel: intent.recipientLabel || null,
          amount,
          asset: String(intent.asset).toUpperCase(),
          frequency: intent.frequency,
          status: 'awaiting_pin',
          nextRunAt: firstRun,
          anchorDay: firstRun.getUTCDate(),
          expiresAt: new Date(now.getTime() + PIN_CONFIRMATION_TTL_MS),
        },
      });
    } catch (error) {
      if (error?.code !== 'P2002') throw error;
    }
  }
  throw new Error('Could not allocate a schedule reference. Please try again.');
};

/**
 * Activates the user's pending mandate if `pin` is correct.
 * Result: { status: 'none' | 'expired' | 'locked' | 'bad_pin' | 'activated', mandate?, retryAfterMs? }
 */
const confirmWithPin = async ({
  prisma = lazy.prisma(),
  user,
  pin,
  now = new Date(),
  verifyPinAttempt = lazy.verifyPinAttempt(),
}) => {
  if (!prisma.recurringPayment) return { status: 'none' };
  const pending = await prisma.recurringPayment.findFirst({
    where: { userId: user.id, status: 'awaiting_pin' },
    orderBy: { createdAt: 'desc' },
  });
  if (!pending) return { status: 'none' };
  if (pending.expiresAt && pending.expiresAt <= now) {
    await prisma.recurringPayment.updateMany({
      where: { id: pending.id, status: 'awaiting_pin' },
      data: { status: 'cancelled' },
    });
    return { status: 'expired' };
  }

  const attempt = await verifyPinAttempt({ prisma, userId: user.id, pin });
  if (!attempt.ok) {
    return attempt.locked
      ? { status: 'locked', retryAfterMs: attempt.retryAfterMs }
      : { status: 'bad_pin' };
  }

  const claimed = await prisma.recurringPayment.updateMany({
    where: { id: pending.id, status: 'awaiting_pin' },
    data: { status: 'active', pinConfirmedAt: now, expiresAt: null },
  });
  if (claimed.count !== 1) return { status: 'none' };
  return { status: 'activated', mandate: { ...pending, status: 'active' } };
};

const listForUser = ({ prisma = lazy.prisma(), userId }) => prisma.recurringPayment.findMany({
  where: { userId, status: { in: ['active', 'paused'] } },
  orderBy: { nextRunAt: 'asc' },
});

/** pause | resume | cancel by user-facing reference. Returns the mandate or null. */
const changeStatus = async ({
  prisma = lazy.prisma(), userId, reference, action, now = new Date(),
}) => {
  const mandate = await prisma.recurringPayment.findUnique({
    where: { userId_reference: { userId, reference: String(reference).toUpperCase() } },
  });
  if (!mandate) return null;

  const rules = {
    pause: { from: ['active'], to: 'paused' },
    resume: { from: ['paused'], to: 'active' },
    cancel: { from: ['active', 'paused', 'awaiting_pin'], to: 'cancelled' },
  };
  const rule = rules[action];
  if (!rule) throw new Error(`Unsupported action: ${action}`);
  if (!rule.from.includes(mandate.status)) return { ...mandate, changed: false };

  const data = { status: rule.to };
  if (action === 'resume') {
    // Never fire immediately for a run that came due while paused.
    if (mandate.nextRunAt <= now) {
      data.nextRunAt = nextRunAfter(mandate.nextRunAt, mandate.frequency, mandate.anchorDay, now);
    }
    data.failureCount = 0;
    data.reminderSentFor = null;
  }
  const result = await prisma.recurringPayment.updateMany({
    where: { id: mandate.id, status: { in: rule.from } },
    data,
  });
  return { ...mandate, ...data, changed: result.count === 1 };
};

const describeMandate = (mandate) => `${mandate.reference}: ${mandate.amount} ${mandate.asset} to ${mandate.destination.slice(0, 6)}...${mandate.destination.slice(-4)} ${mandate.frequency}, next ${new Date(mandate.nextRunAt).toISOString().slice(0, 10)}${mandate.status === 'paused' ? ' (paused)' : ''}`;

/** Sends the 24h heads-up once per occurrence. */
const sendUpcomingReminders = async ({
  prisma = lazy.prisma(),
  notify = lazy.notify(),
  now = new Date(),
  batchSize = DEFAULT_BATCH_SIZE,
  log = logger,
} = {}) => {
  const due = await prisma.recurringPayment.findMany({
    where: { status: 'active', nextRunAt: { gt: now, lte: new Date(now.getTime() + REMINDER_LEAD_MS) } },
    include: { user: { select: { phoneNumber: true } } },
    orderBy: { nextRunAt: 'asc' },
    take: batchSize,
  });

  let sent = 0;
  for (const mandate of due) {
    if (mandate.reminderSentFor && new Date(mandate.reminderSentFor).getTime() === new Date(mandate.nextRunAt).getTime()) continue;
    const claim = await prisma.recurringPayment.updateMany({
      where: {
        id: mandate.id,
        status: 'active',
        nextRunAt: mandate.nextRunAt,
        OR: [{ reminderSentFor: null }, { reminderSentFor: { not: mandate.nextRunAt } }],
      },
      data: { reminderSentFor: mandate.nextRunAt },
    });
    if (claim.count !== 1) continue;
    try {
      await notify(
        mandate.user.phoneNumber,
        `Upcoming payment in 24 hours: ${describeMandate(mandate)}.\nReply "pause ${mandate.reference}" to pause or "cancel ${mandate.reference}" to cancel.`,
      );
      sent += 1;
    } catch (error) {
      // Release the claim so the next tick retries the reminder.
      await prisma.recurringPayment.updateMany({
        where: { id: mandate.id, reminderSentFor: mandate.nextRunAt },
        data: { reminderSentFor: mandate.reminderSentFor || null },
      });
      log.warn('recurring_reminder_failed', { id: mandate.id, message: error.message });
    }
  }
  return { sent };
};

/** Executes every due occurrence exactly once. */
const runDueRecurringPayments = async ({
  prisma = lazy.prisma(),
  execute = lazy.execute(),
  notify = lazy.notify(),
  now = new Date(),
  batchSize = DEFAULT_BATCH_SIZE,
  log = logger,
} = {}) => {
  await prisma.recurringPayment.updateMany({
    where: { status: 'awaiting_pin', expiresAt: { lte: now } },
    data: { status: 'cancelled' },
  });

  const due = await prisma.recurringPayment.findMany({
    where: { status: 'active', nextRunAt: { lte: now } },
    include: { user: true },
    orderBy: { nextRunAt: 'asc' },
    take: batchSize,
  });

  const summary = { executed: 0, failed: 0, skipped: 0 };
  for (const mandate of due) {
    const occurrence = new Date(mandate.nextRunAt);
    const claim = await prisma.recurringPayment.updateMany({
      where: { id: mandate.id, status: 'active', nextRunAt: mandate.nextRunAt },
      data: {
        nextRunAt: nextRunAfter(occurrence, mandate.frequency, mandate.anchorDay, now),
        lastRunAt: now,
      },
    });
    if (claim.count !== 1) {
      summary.skipped += 1;
      continue;
    }

    const phone = mandate.user.phoneNumber;
    try {
      const result = await execute({
        sender: mandate.user,
        destination: mandate.destination,
        amount: mandate.amount,
        asset: mandate.asset,
        memo: mandate.memo || undefined,
        memoType: mandate.memoType || undefined,
        idempotencyKey: `recurring:${mandate.id}:${occurrence.toISOString()}`,
      });
      await prisma.recurringPayment.updateMany({
        where: { id: mandate.id },
        data: { failureCount: 0, lastTransactionId: result?.transaction?.id || null },
      });
      summary.executed += 1;
      await safeNotify(notify, phone, `Recurring payment sent: ${mandate.amount} ${mandate.asset} (${mandate.reference}).`, log);
    } catch (error) {
      summary.failed += 1;
      const failures = mandate.failureCount + 1;
      const pauseNow = failures >= MAX_CONSECUTIVE_FAILURES;
      await prisma.recurringPayment.updateMany({
        where: { id: mandate.id },
        data: { failureCount: failures, ...(pauseNow ? { status: 'paused' } : {}) },
      });
      log.error('recurring_payment_failed', { id: mandate.id, failures, message: error.message });
      await safeNotify(
        notify,
        phone,
        `Recurring payment ${mandate.reference} of ${mandate.amount} ${mandate.asset} failed: ${error.message}.${pauseNow ? ` It has been paused after ${failures} failures; reply "resume ${mandate.reference}" to restart it.` : ''}`,
        log,
      );
    }
  }
  return summary;
};

const safeNotify = async (notify, to, message, log) => {
  try {
    await notify(to, message);
  } catch (error) {
    log.warn('recurring_notification_failed', { message: error.message });
  }
};

/**
 * WhatsApp entry point. Returns true when the message was handled here.
 * `hasPendingSend` lets the existing send-confirmation PIN step keep priority.
 */
const handleRecurringMessage = async ({
  phoneNumber, user, text, notify, prisma = lazy.prisma(), hasPendingSend = false, deps = {},
}) => {
  const intent = parseRecurringCommand(text);

  if (intent?.kind === 'schedule') {
    try {
      const mandate = await requestRecurringPayment({ prisma, user, intent, ...deps });
      await notify(
        phoneNumber,
        `Confirm recurring payment: ${mandate.amount} ${mandate.asset} to ${mandate.destination} ${mandate.frequency}, first run ${mandate.nextRunAt.toISOString().slice(0, 10)}.\nReply with your PIN within 10 minutes to confirm.`,
      );
    } catch (error) {
      await notify(phoneNumber, `Could not set up the recurring payment: ${error.message}`);
    }
    return true;
  }

  if (intent?.kind === 'manage') {
    const result = await changeStatus({ prisma, userId: user.id, reference: intent.reference, action: intent.action });
    if (!result) {
      // "cancel <word>" may belong to another flow; only claim 6-char refs we know.
      await notify(phoneNumber, `No recurring payment found with reference ${intent.reference}.`);
    } else if (!result.changed) {
      await notify(phoneNumber, `Recurring payment ${result.reference} is ${result.status}; nothing to ${intent.action}.`);
    } else {
      const past = { pause: 'paused', resume: 'resumed', cancel: 'cancelled' }[intent.action];
      await notify(phoneNumber, `Recurring payment ${result.reference} ${past}.`);
    }
    return true;
  }

  if (intent?.kind === 'list') {
    const mandates = await listForUser({ prisma, userId: user.id });
    await notify(phoneNumber, mandates.length ? mandates.map(describeMandate).join('\n') : 'You have no recurring payments.');
    return true;
  }

  if (!hasPendingSend && /^\d{4,8}$/.test(String(text || '').trim())) {
    const result = await confirmWithPin({ prisma, user, pin: String(text).trim(), ...deps });
    if (result.status === 'none') return false;
    const messages = {
      expired: 'That recurring payment request expired. Please send it again.',
      bad_pin: 'Incorrect PIN. The recurring payment was not activated.',
      locked: `PIN verification failed. Your account is temporarily locked. Try again in ${Math.max(1, Math.ceil((result.retryAfterMs || 0) / 1000))} seconds.`,
      activated: result.mandate
        ? `Recurring payment ${result.mandate.reference} is active: ${result.mandate.amount} ${result.mandate.asset} ${result.mandate.frequency}. You will get a reminder 24 hours before each payment.`
        : '',
    };
    await notify(phoneNumber, messages[result.status]);
    return true;
  }
  return false;
};

const startRecurringPaymentScheduler = ({
  prisma,
  intervalMs = Number(process.env.RECURRING_PAYMENTS_INTERVAL_MS || DEFAULT_INTERVAL_MS),
  run = async () => {
    await sendUpcomingReminders({ prisma });
    await runDueRecurringPayments({ prisma });
  },
  log = logger,
} = {}) => {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await run();
    } catch (error) {
      log.error('recurring_scheduler_failed', { message: error.message });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  log.info('recurring_payment_scheduler_started', { intervalMs });
  return { tick, stop: () => clearInterval(timer) };
};

module.exports = {
  FREQUENCIES,
  MAX_CONSECUTIVE_FAILURES,
  computeNextRun,
  nextRunAfter,
  parseRecurringCommand,
  requestRecurringPayment,
  confirmWithPin,
  listForUser,
  changeStatus,
  sendUpcomingReminders,
  runDueRecurringPayments,
  handleRecurringMessage,
  startRecurringPaymentScheduler,
};
