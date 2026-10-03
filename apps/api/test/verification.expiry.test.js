'use strict';

// Verification expiry service unit tests — #442
//
// Covers src/compliance/verification.expiry.js: the expiry classifiers at and
// around each policy threshold, the escalation grace period, the reminder
// throttles, and the sweep that dispatches reminders and enforcement.
//
// Date is frozen with node:test mock timers so every threshold can be probed
// to the millisecond. Prisma, the audit service and the logger are in-memory
// fakes injected before the SUT is loaded.

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const injectMock = (relFromSrc, factory) => {
  const abs = path.resolve(__dirname, '../src', `${relFromSrc}.js`);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: factory() };
};

// Recorded side effects, reset before each test.
const calls = { findMany: [], notifications: [], kycUpdates: [], userUpdates: [], audits: [], logs: [] };
let profilesToReturn = [];
let failNotificationFor = null;

injectMock('common/prisma', () => ({
  kycProfile: {
    findMany: async (args) => {
      calls.findMany.push(args);
      return profilesToReturn;
    },
    update: async (args) => {
      calls.kycUpdates.push(args);
      return { id: args.where.id, ...args.data };
    },
  },
  notification: {
    create: async (args) => {
      if (failNotificationFor && args.data.referenceId === failNotificationFor) {
        throw new Error('notification store unavailable');
      }
      calls.notifications.push(args);
      return { id: `notif_${calls.notifications.length}`, ...args.data };
    },
  },
  user: {
    update: async (args) => {
      calls.userUpdates.push(args);
      return { id: args.where.id, ...args.data };
    },
  },
}));
injectMock('common/audit.service', () => ({
  writeAuditLog: async (entry) => {
    calls.audits.push(entry);
    return { id: `audit_${calls.audits.length}` };
  },
}));
injectMock('utils/logger', () => ({
  info: (...args) => calls.logs.push(['info', ...args]),
  warn: (...args) => calls.logs.push(['warn', ...args]),
  error: (...args) => calls.logs.push(['error', ...args]),
}));
// No compliance overrides: the module falls back to its documented defaults.
injectMock('config/env', () => ({ compliance: {} }));

const {
  runVerificationExpirySweep,
  getVerificationExpiryStatus,
  isSanctionExpired,
  isKycStale,
  isEscalationDue,
  SANCTION_EXPIRY_DAYS,
  KYC_STALE_DAYS,
  KYC_ESCALATION_DAYS,
} = require('../src/compliance/verification.expiry');

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-26T12:00:00.000Z');

/** A Date `days` days (plus optional extra ms) before the frozen NOW. */
const ago = (days, extraMs = 0) => new Date(NOW - days * MS_PER_DAY - extraMs);

beforeEach(() => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  for (const key of Object.keys(calls)) calls[key].length = 0;
  profilesToReturn = [];
  failNotificationFor = null;
});

afterEach(() => {
  mock.timers.reset();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeUser = (overrides = {}) => ({
  id: 'user_1',
  phoneNumber: '+2349000000001',
  kycTier: 1,
  anonymizedAt: null,
  ...overrides,
});

// An approved, recently screened, recently updated profile: nothing is due.
const makeProfile = (overrides = {}) => ({
  id: 'kyc_1',
  status: 'approved',
  sanctionsStatus: 'clear',
  lastScreenedAt: ago(1),
  updatedAt: ago(1),
  metadata: {},
  user: makeUser(),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Policy defaults
// ---------------------------------------------------------------------------

describe('policy defaults', () => {
  test('uses the documented default windows when config has no overrides', () => {
    assert.equal(SANCTION_EXPIRY_DAYS, 180);
    assert.equal(KYC_STALE_DAYS, 365);
    assert.equal(KYC_ESCALATION_DAYS, 30);
  });
});

// ---------------------------------------------------------------------------
// isSanctionExpired
// ---------------------------------------------------------------------------

describe('isSanctionExpired', () => {
  test('not yet expired: screened recently', () => {
    assert.equal(isSanctionExpired({ lastScreenedAt: ago(1) }), false);
  });

  test('boundary: exactly at the expiry window is not yet expired', () => {
    assert.equal(isSanctionExpired({ lastScreenedAt: ago(SANCTION_EXPIRY_DAYS) }), false);
  });

  test('boundary: one millisecond past the expiry window is expired', () => {
    assert.equal(isSanctionExpired({ lastScreenedAt: ago(SANCTION_EXPIRY_DAYS, 1) }), true);
  });

  test('boundary: one millisecond before the expiry window is not expired', () => {
    assert.equal(isSanctionExpired({ lastScreenedAt: ago(SANCTION_EXPIRY_DAYS, -1) }), false);
  });

  test('far past expiry is expired', () => {
    assert.equal(isSanctionExpired({ lastScreenedAt: ago(SANCTION_EXPIRY_DAYS * 10) }), true);
  });

  test('never screened is treated as expired', () => {
    assert.equal(isSanctionExpired({ lastScreenedAt: null }), true);
    assert.equal(isSanctionExpired({}), true);
  });

  test('accepts ISO string timestamps', () => {
    assert.equal(isSanctionExpired({ lastScreenedAt: ago(1).toISOString() }), false);
    assert.equal(
      isSanctionExpired({ lastScreenedAt: ago(SANCTION_EXPIRY_DAYS, 1).toISOString() }),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// isKycStale
// ---------------------------------------------------------------------------

describe('isKycStale', () => {
  test('not yet stale: approved recently', () => {
    assert.equal(isKycStale({ status: 'approved', updatedAt: ago(1) }), false);
  });

  test('boundary: exactly at the stale window is not yet stale', () => {
    assert.equal(isKycStale({ status: 'approved', updatedAt: ago(KYC_STALE_DAYS) }), false);
  });

  test('boundary: one millisecond past the stale window is stale', () => {
    assert.equal(isKycStale({ status: 'approved', updatedAt: ago(KYC_STALE_DAYS, 1) }), true);
  });

  test('far past the stale window is stale', () => {
    assert.equal(isKycStale({ status: 'approved', updatedAt: ago(KYC_STALE_DAYS * 5) }), true);
  });

  test('approved with no updatedAt is treated as stale', () => {
    assert.equal(isKycStale({ status: 'approved', updatedAt: null }), true);
  });

  test('non-approved profiles are never stale, however old', () => {
    for (const status of ['not_started', 'pending', 'review', 'rejected']) {
      assert.equal(isKycStale({ status, updatedAt: ago(KYC_STALE_DAYS * 5) }), false, status);
    }
  });
});

// ---------------------------------------------------------------------------
// isEscalationDue — the grace period after a stale reminder
// ---------------------------------------------------------------------------

describe('isEscalationDue (grace period)', () => {
  const staleProfile = (lastReminderSentAt) => ({
    status: 'approved',
    updatedAt: ago(KYC_STALE_DAYS + 10),
    metadata: lastReminderSentAt === undefined ? {} : { lastReminderSentAt },
  });

  test('not due when the profile is not stale, even with an old reminder', () => {
    assert.equal(
      isEscalationDue({ status: 'approved', updatedAt: ago(1), metadata: { lastReminderSentAt: ago(365).toISOString() } }),
      false,
    );
  });

  test('not due when no reminder has been sent yet', () => {
    assert.equal(isEscalationDue(staleProfile()), false);
    assert.equal(isEscalationDue({ status: 'approved', updatedAt: ago(KYC_STALE_DAYS + 10) }), false);
  });

  test('not due while still inside the grace period', () => {
    assert.equal(isEscalationDue(staleProfile(ago(1).toISOString())), false);
  });

  test('boundary: exactly at the end of the grace period is not yet due', () => {
    assert.equal(isEscalationDue(staleProfile(ago(KYC_ESCALATION_DAYS).toISOString())), false);
  });

  test('boundary: one millisecond past the grace period is due', () => {
    assert.equal(isEscalationDue(staleProfile(ago(KYC_ESCALATION_DAYS, 1).toISOString())), true);
  });

  test('far past the grace period is due', () => {
    assert.equal(isEscalationDue(staleProfile(ago(KYC_ESCALATION_DAYS * 12).toISOString())), true);
  });
});

// ---------------------------------------------------------------------------
// getVerificationExpiryStatus
// ---------------------------------------------------------------------------

describe('getVerificationExpiryStatus', () => {
  test('reports a healthy profile with the active policy', () => {
    const status = getVerificationExpiryStatus(makeProfile());

    assert.deepEqual(status, {
      isSanctionExpired: false,
      isKycStale: false,
      isEscalationDue: false,
      lastReminderSentAt: null,
      lastReminderType: null,
      escalatedAt: null,
      policy: { sanctionExpiryDays: 180, kycStaleDays: 365, kycEscalationDays: 30 },
    });
  });

  test('reports expiry, staleness, escalation and reminder metadata', () => {
    const lastReminderSentAt = ago(KYC_ESCALATION_DAYS + 1).toISOString();
    const status = getVerificationExpiryStatus(makeProfile({
      lastScreenedAt: ago(SANCTION_EXPIRY_DAYS + 1),
      updatedAt: ago(KYC_STALE_DAYS + 1),
      metadata: { lastReminderSentAt, lastReminderType: 'stale', escalatedAt: null },
    }));

    assert.equal(status.isSanctionExpired, true);
    assert.equal(status.isKycStale, true);
    assert.equal(status.isEscalationDue, true);
    assert.equal(status.lastReminderSentAt, lastReminderSentAt);
    assert.equal(status.lastReminderType, 'stale');
    assert.equal(status.escalatedAt, null);
  });

  test('tolerates a profile with no metadata', () => {
    const status = getVerificationExpiryStatus(makeProfile({ metadata: null }));
    assert.equal(status.lastReminderSentAt, null);
    assert.equal(status.lastReminderType, null);
    assert.equal(status.escalatedAt, null);
  });
});

// ---------------------------------------------------------------------------
// runVerificationExpirySweep
// ---------------------------------------------------------------------------

describe('runVerificationExpirySweep', () => {
  test('queries approved and not_started profiles, oldest first, bounded by batch size', async () => {
    await runVerificationExpirySweep();

    assert.equal(calls.findMany.length, 1);
    assert.deepEqual(calls.findMany[0], {
      where: { status: { in: ['approved', 'not_started'] } },
      include: {
        user: { select: { id: true, phoneNumber: true, kycTier: true, anonymizedAt: true } },
      },
      orderBy: { updatedAt: 'asc' },
      take: 200,
    });
  });

  test('returns zero counts and touches nothing when no profile is due', async () => {
    profilesToReturn = [makeProfile()];

    const result = await runVerificationExpirySweep();

    assert.deepEqual(result, { reminders: 0, escalations: 0, errors: 0 });
    assert.equal(calls.notifications.length, 0);
    assert.equal(calls.kycUpdates.length, 0);
    assert.equal(calls.audits.length, 0);
  });

  test('sanctions just past expiry queues an expired_sanctions reminder with audit trail', async () => {
    profilesToReturn = [makeProfile({ lastScreenedAt: ago(SANCTION_EXPIRY_DAYS, 1) })];

    const result = await runVerificationExpirySweep();

    assert.deepEqual(result, { reminders: 1, escalations: 0, errors: 0 });

    assert.equal(calls.notifications.length, 1);
    const { data } = calls.notifications[0];
    assert.equal(data.userId, 'user_1');
    assert.equal(data.channel, 'whatsapp');
    assert.equal(data.type, 'verification_reminder.expired_sanctions');
    assert.equal(data.recipient, '+2349000000001');
    assert.equal(data.status, 'queued');
    assert.equal(data.referenceType, 'KycProfile');
    assert.equal(data.referenceId, 'kyc_1');
    assert.match(data.body, /VERIFY/);

    assert.equal(calls.kycUpdates.length, 1);
    assert.deepEqual(calls.kycUpdates[0], {
      where: { id: 'kyc_1' },
      data: {
        metadata: {
          lastReminderSentAt: new Date(NOW).toISOString(),
          lastReminderType: 'expired_sanctions',
        },
      },
    });

    assert.equal(calls.audits.length, 1);
    assert.equal(calls.audits[0].action, 'verification.reminder.sent');
    assert.equal(calls.audits[0].actorType, 'system');
    assert.equal(calls.audits[0].actorId, 'verification-expiry-job');
    assert.equal(calls.audits[0].entityId, 'kyc_1');
    assert.equal(calls.audits[0].metadata.reminderType, 'expired_sanctions');
    assert.equal(calls.audits[0].metadata.userId, 'user_1');
  });

  test('sanctions exactly at the expiry threshold do not trigger a reminder', async () => {
    profilesToReturn = [makeProfile({ lastScreenedAt: ago(SANCTION_EXPIRY_DAYS) })];

    const result = await runVerificationExpirySweep();

    assert.deepEqual(result, { reminders: 0, escalations: 0, errors: 0 });
  });

  test('stale KYC with no prior reminder queues a stale reminder and preserves metadata', async () => {
    profilesToReturn = [makeProfile({ updatedAt: ago(KYC_STALE_DAYS, 1), metadata: { source: 'smileid' } })];

    const result = await runVerificationExpirySweep();

    assert.deepEqual(result, { reminders: 1, escalations: 0, errors: 0 });
    assert.equal(calls.notifications[0].data.type, 'verification_reminder.stale');
    assert.deepEqual(calls.kycUpdates[0].data.metadata, {
      source: 'smileid',
      lastReminderSentAt: new Date(NOW).toISOString(),
      lastReminderType: 'stale',
    });
  });

  test('stale KYC reminded within the last 7 days is not re-sent', async () => {
    profilesToReturn = [makeProfile({
      updatedAt: ago(KYC_STALE_DAYS + 5),
      metadata: { lastReminderSentAt: ago(7, -1).toISOString() },
    })];

    const result = await runVerificationExpirySweep();

    assert.deepEqual(result, { reminders: 0, escalations: 0, errors: 0 });
    assert.equal(calls.notifications.length, 0);
  });

  test('stale KYC reminded 7+ days ago but inside the grace period gets another reminder', async () => {
    profilesToReturn = [makeProfile({
      updatedAt: ago(KYC_STALE_DAYS + 20),
      metadata: { lastReminderSentAt: ago(7).toISOString() },
    })];

    const result = await runVerificationExpirySweep();

    assert.deepEqual(result, { reminders: 1, escalations: 0, errors: 0 });
    assert.equal(calls.notifications[0].data.type, 'verification_reminder.stale');
    assert.equal(calls.userUpdates.length, 0);
  });

  test('stale KYC whose reminder is past the grace period is escalated to review', async () => {
    const lastReminderSentAt = ago(KYC_ESCALATION_DAYS, 1).toISOString();
    profilesToReturn = [makeProfile({
      updatedAt: ago(KYC_STALE_DAYS + 40),
      metadata: { lastReminderSentAt, lastReminderType: 'stale' },
    })];

    const result = await runVerificationExpirySweep();

    assert.deepEqual(result, { reminders: 0, escalations: 1, errors: 0 });
    assert.equal(calls.notifications.length, 0, 'escalation takes priority over reminders');

    assert.deepEqual(calls.kycUpdates[0], {
      where: { id: 'kyc_1' },
      data: {
        status: 'review',
        deniedReason: 'Re-verification overdue: compliance escalation (automated)',
        metadata: {
          lastReminderSentAt,
          lastReminderType: 'stale',
          escalatedAt: new Date(NOW).toISOString(),
          escalationReason: 'kyc_stale_reminder_not_actioned',
        },
      },
    });
    assert.deepEqual(calls.userUpdates[0], { where: { id: 'user_1' }, data: { kycTier: 0 } });

    assert.equal(calls.audits.length, 1);
    assert.equal(calls.audits[0].action, 'verification.escalation.enforced');
    assert.equal(calls.audits[0].metadata.previousStatus, 'approved');
    assert.equal(calls.audits[0].metadata.newStatus, 'review');
    assert.equal(calls.audits[0].metadata.escalationDays, KYC_ESCALATION_DAYS);
    assert.ok(calls.logs.some(([level, event]) => level === 'warn' && event === 'verification_escalation_enforced'));
  });

  test('escalation takes priority over expired sanctions', async () => {
    profilesToReturn = [makeProfile({
      lastScreenedAt: ago(SANCTION_EXPIRY_DAYS * 3),
      updatedAt: ago(KYC_STALE_DAYS * 2),
      metadata: { lastReminderSentAt: ago(KYC_ESCALATION_DAYS * 2).toISOString() },
    })];

    const result = await runVerificationExpirySweep();

    assert.deepEqual(result, { reminders: 0, escalations: 1, errors: 0 });
  });

  test('tier-0 not_started profile gets a missing-verification nudge', async () => {
    profilesToReturn = [makeProfile({
      status: 'not_started',
      lastScreenedAt: null,
      user: makeUser({ kycTier: 0 }),
    })];

    const result = await runVerificationExpirySweep();

    assert.deepEqual(result, { reminders: 1, escalations: 0, errors: 0 });
    assert.equal(calls.notifications[0].data.type, 'verification_reminder.missing');
  });

  test('missing-verification nudge is throttled to once per 14 days', async () => {
    const notStarted = (lastReminderSentAt) => makeProfile({
      status: 'not_started',
      lastScreenedAt: null,
      metadata: { lastReminderSentAt },
      user: makeUser({ kycTier: 0 }),
    });

    profilesToReturn = [notStarted(ago(14, -1).toISOString())];
    assert.deepEqual(await runVerificationExpirySweep(), { reminders: 0, escalations: 0, errors: 0 });

    profilesToReturn = [notStarted(ago(14).toISOString())];
    assert.deepEqual(await runVerificationExpirySweep(), { reminders: 1, escalations: 0, errors: 0 });
  });

  test('not_started profile for a user who already holds a tier is not nudged', async () => {
    profilesToReturn = [makeProfile({ status: 'not_started', user: makeUser({ kycTier: 1 }) })];

    const result = await runVerificationExpirySweep();

    assert.deepEqual(result, { reminders: 0, escalations: 0, errors: 0 });
  });

  test('skips anonymized users and profiles with no user', async () => {
    profilesToReturn = [
      makeProfile({ id: 'kyc_anon', lastScreenedAt: null, user: makeUser({ anonymizedAt: ago(1) }) }),
      makeProfile({ id: 'kyc_orphan', lastScreenedAt: null, user: null }),
    ];

    const result = await runVerificationExpirySweep();

    assert.deepEqual(result, { reminders: 0, escalations: 0, errors: 0 });
    assert.equal(calls.notifications.length, 0);
  });

  test('a failure on one profile is counted and does not stop the sweep', async () => {
    failNotificationFor = 'kyc_bad';
    profilesToReturn = [
      makeProfile({ id: 'kyc_bad', lastScreenedAt: null }),
      makeProfile({ id: 'kyc_good', lastScreenedAt: null, user: makeUser({ id: 'user_2' }) }),
    ];

    const result = await runVerificationExpirySweep();

    assert.deepEqual(result, { reminders: 1, escalations: 0, errors: 1 });
    assert.equal(calls.notifications.length, 1);
    assert.equal(calls.notifications[0].data.referenceId, 'kyc_good');
    const errorLog = calls.logs.find(([level]) => level === 'error');
    assert.equal(errorLog[1], 'verification_expiry_sweep_item_error');
    assert.deepEqual(errorLog[2], {
      profileId: 'kyc_bad',
      userId: 'user_1',
      error: 'notification store unavailable',
    });
  });

  test('logs sweep start with the active policy and completion with the counts', async () => {
    profilesToReturn = [makeProfile({ lastScreenedAt: null })];

    await runVerificationExpirySweep();

    const started = calls.logs.find(([, event]) => event === 'verification_expiry_sweep_started');
    assert.deepEqual(started[2], {
      sanctionExpiryDays: 180,
      kycStaleDays: 365,
      kycEscalationDays: 30,
      batchSize: 200,
    });
    const complete = calls.logs.find(([, event]) => event === 'verification_expiry_sweep_complete');
    assert.deepEqual(complete[2], { reminders: 1, escalations: 0, errors: 0 });
  });
});
