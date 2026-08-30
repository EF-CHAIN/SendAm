'use strict';

/**
 * Verification Expiry & Re-verification Reminder Service (#333)
 * --------------------------------------------------------------
 * Defines verification expiry policy, scans for stale/missing KYC data,
 * and sends WhatsApp reminder messages. All reminder events are logged to
 * the audit trail so compliance teams can review expiry and escalation state.
 *
 * Policy hierarchy (most-to-least aggressive):
 *   EXPIRED  — sanctions screened > SANCTION_EXPIRY_DAYS ago → immediate enforcement
 *   STALE    — KYC approved > KYC_STALE_DAYS ago without re-verification → reminder
 *   MISSING  — KYC tier 0 with no profile started → nudge
 *
 * All intervals are overridable via environment / compliance config.
 */

const prisma = require('../common/prisma');
const logger = require('../utils/logger');
const { writeAuditLog } = require('../common/audit.service');
const config = require('../config/env');

// ── Policy constants ──────────────────────────────────────────────────────

/** Days after last sanctions screening before a profile is considered expired. */
const SANCTION_EXPIRY_DAYS = Number(
  config.compliance?.sanctionExpiryDays ?? 180,
);

/** Days after KYC approval before we send a re-verification reminder. */
const KYC_STALE_DAYS = Number(
  config.compliance?.kycStaleDays ?? 365,
);

/**
 * Days after the STALE reminder before we escalate to enforcement (block
 * new transactions until re-verification is done).
 */
const KYC_ESCALATION_DAYS = Number(
  config.compliance?.kycEscalationDays ?? 30,
);

/** Maximum users processed per sweep to bound DB load. */
const BATCH_SIZE = Number(config.compliance?.expiryBatchSize ?? 200);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── Expiry classifiers ────────────────────────────────────────────────────

/**
 * Returns `true` if the sanctions screening result is past the expiry window.
 */
const isSanctionExpired = (profile) => {
  if (!profile.lastScreenedAt) return true;
  const age = Date.now() - new Date(profile.lastScreenedAt).getTime();
  return age > SANCTION_EXPIRY_DAYS * MS_PER_DAY;
};

/**
 * Returns `true` if the KYC approval is old enough to warrant a reminder.
 */
const isKycStale = (profile) => {
  if (profile.status !== 'approved') return false;
  if (!profile.updatedAt) return true;
  const age = Date.now() - new Date(profile.updatedAt).getTime();
  return age > KYC_STALE_DAYS * MS_PER_DAY;
};

/**
 * Returns `true` if a stale reminder was sent > KYC_ESCALATION_DAYS ago and
 * the user has still not re-verified (profile is still approved + stale).
 */
const isEscalationDue = (profile) => {
  if (!isKycStale(profile)) return false;
  const lastReminder = profile.metadata?.lastReminderSentAt;
  if (!lastReminder) return false;
  const age = Date.now() - new Date(lastReminder).getTime();
  return age > KYC_ESCALATION_DAYS * MS_PER_DAY;
};

// ── Reminder delivery ─────────────────────────────────────────────────────

/**
 * Build the WhatsApp reminder message body.
 * @param {'stale'|'expired_sanctions'|'missing'|'escalation'} type
 */
const reminderBody = (type) => {
  switch (type) {
    case 'missing':
      return '👋 Hi! Your SendAm account still needs identity verification before you can send money. Reply *VERIFY* to start — it only takes a few minutes.';
    case 'stale':
      return '🔒 Your SendAm identity verification is due for renewal. Please reply *VERIFY* to complete a quick re-check and keep your account active.';
    case 'expired_sanctions':
      return '⚠️ A required compliance check on your account has expired. Please reply *VERIFY* to re-verify and restore full sending access.';
    case 'escalation':
      return '‼️ Your SendAm verification renewal is overdue. New transactions may be restricted until you complete re-verification. Reply *VERIFY* now to resolve this.';
    default:
      return '🔔 Please complete your SendAm identity verification to keep your account active. Reply *VERIFY* to start.';
  }
};

/**
 * Persist a notification record and write an audit log entry for a single
 * reminder so compliance teams can see the full history.
 */
const sendReminder = async ({ user, profile, reminderType }) => {
  const body = reminderBody(reminderType);

  // Persist a Notification row (delivery is handled by existing WhatsApp
  // notification infrastructure when it picks up queued rows).
  await prisma.notification.create({
    data: {
      userId: user.id,
      channel: 'whatsapp',
      type: `verification_reminder.${reminderType}`,
      recipient: user.phoneNumber,
      body,
      status: 'queued',
      referenceType: 'KycProfile',
      referenceId: profile.id,
    },
  });

  // Stamp the profile so the next sweep won't re-send immediately.
  await prisma.kycProfile.update({
    where: { id: profile.id },
    data: {
      metadata: {
        ...(profile.metadata || {}),
        lastReminderSentAt: new Date().toISOString(),
        lastReminderType: reminderType,
      },
    },
  });

  // Audit log — compliance reviewers can query action='verification.reminder.sent'.
  await writeAuditLog({
    actorType: 'system',
    actorId: 'verification-expiry-job',
    action: 'verification.reminder.sent',
    entityType: 'KycProfile',
    entityId: profile.id,
    metadata: {
      reminderType,
      userId: user.id,
      kycStatus: profile.status,
      sanctionsStatus: profile.sanctionsStatus,
      lastScreenedAt: profile.lastScreenedAt?.toISOString?.() ?? null,
      profileUpdatedAt: profile.updatedAt?.toISOString?.() ?? null,
      policyVersion: '2026-08-29',
    },
  });

  logger.info('verification_reminder_sent', {
    userId: user.id,
    profileId: profile.id,
    reminderType,
  });
};

// ── Enforcement ───────────────────────────────────────────────────────────

/**
 * Move a profile to 'review' when escalation criteria are met.
 * This blocks new transactions via `enforceTransactionPolicy` (which rejects
 * non-'approved' status) until an operator re-clears the profile.
 */
const escalateToReview = async ({ user, profile }) => {
  await prisma.kycProfile.update({
    where: { id: profile.id },
    data: {
      status: 'review',
      deniedReason: 'Re-verification overdue: compliance escalation (automated)',
      metadata: {
        ...(profile.metadata || {}),
        escalatedAt: new Date().toISOString(),
        escalationReason: 'kyc_stale_reminder_not_actioned',
      },
    },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { kycTier: 0 },
  });

  await writeAuditLog({
    actorType: 'system',
    actorId: 'verification-expiry-job',
    action: 'verification.escalation.enforced',
    entityType: 'KycProfile',
    entityId: profile.id,
    metadata: {
      userId: user.id,
      reason: 'kyc_stale_reminder_not_actioned',
      previousStatus: profile.status,
      newStatus: 'review',
      escalationDays: KYC_ESCALATION_DAYS,
      policyVersion: '2026-08-29',
    },
  });

  logger.warn('verification_escalation_enforced', {
    userId: user.id,
    profileId: profile.id,
    reason: 'kyc_stale_reminder_not_actioned',
  });
};

// ── Main sweep ────────────────────────────────────────────────────────────

/**
 * Scan KYC profiles and dispatch reminders / enforcement actions.
 *
 * @returns {{ reminders: number, escalations: number, errors: number }}
 */
const runVerificationExpirySweep = async () => {
  let reminders = 0;
  let escalations = 0;
  let errors = 0;

  logger.info('verification_expiry_sweep_started', {
    sanctionExpiryDays: SANCTION_EXPIRY_DAYS,
    kycStaleDays: KYC_STALE_DAYS,
    kycEscalationDays: KYC_ESCALATION_DAYS,
    batchSize: BATCH_SIZE,
  });

  // Fetch profiles needing attention:
  //   - Approved profiles (sanctions may have expired, or KYC is stale)
  //   - not_started profiles (missing verification nudge)
  const profiles = await prisma.kycProfile.findMany({
    where: {
      status: { in: ['approved', 'not_started'] },
    },
    include: {
      user: { select: { id: true, phoneNumber: true, kycTier: true, anonymizedAt: true } },
    },
    orderBy: { updatedAt: 'asc' },
    take: BATCH_SIZE,
  });

  for (const profile of profiles) {
    const user = profile.user;

    // Skip anonymized / deleted users.
    if (!user || user.anonymizedAt) continue;

    try {
      // ── 1. Escalation (highest priority) ───────────────────────────────
      if (isEscalationDue(profile)) {
        await escalateToReview({ user, profile });
        escalations++;
        continue;
      }

      // ── 2. Expired sanctions screening ──────────────────────────────────
      if (profile.status === 'approved' && isSanctionExpired(profile)) {
        await sendReminder({ user, profile, reminderType: 'expired_sanctions' });
        reminders++;
        continue;
      }

      // ── 3. Stale KYC ────────────────────────────────────────────────────
      if (isKycStale(profile)) {
        const alreadyRemindedRecently = (() => {
          const last = profile.metadata?.lastReminderSentAt;
          if (!last) return false;
          // Don't re-send a stale reminder more often than once per 7 days.
          return Date.now() - new Date(last).getTime() < 7 * MS_PER_DAY;
        })();
        if (!alreadyRemindedRecently) {
          await sendReminder({ user, profile, reminderType: 'stale' });
          reminders++;
        }
        continue;
      }

      // ── 4. Missing verification (tier-0 not started) ────────────────────
      if (profile.status === 'not_started' && user.kycTier === 0) {
        const alreadyNudged = (() => {
          const last = profile.metadata?.lastReminderSentAt;
          if (!last) return false;
          return Date.now() - new Date(last).getTime() < 14 * MS_PER_DAY;
        })();
        if (!alreadyNudged) {
          await sendReminder({ user, profile, reminderType: 'missing' });
          reminders++;
        }
      }
    } catch (err) {
      errors++;
      logger.error('verification_expiry_sweep_item_error', {
        profileId: profile.id,
        userId: user?.id,
        error: err.message,
      });
    }
  }

  logger.info('verification_expiry_sweep_complete', { reminders, escalations, errors });
  return { reminders, escalations, errors };
};

// ── Admin status query ────────────────────────────────────────────────────

/**
 * Returns expiry and escalation status for a single KYC profile.
 * Used by the admin API to surface expiry state for compliance review.
 */
const getVerificationExpiryStatus = (profile) => {
  const status = {
    isSanctionExpired: isSanctionExpired(profile),
    isKycStale: isKycStale(profile),
    isEscalationDue: isEscalationDue(profile),
    lastReminderSentAt: profile.metadata?.lastReminderSentAt ?? null,
    lastReminderType: profile.metadata?.lastReminderType ?? null,
    escalatedAt: profile.metadata?.escalatedAt ?? null,
    policy: {
      sanctionExpiryDays: SANCTION_EXPIRY_DAYS,
      kycStaleDays: KYC_STALE_DAYS,
      kycEscalationDays: KYC_ESCALATION_DAYS,
    },
  };
  return status;
};

module.exports = {
  runVerificationExpirySweep,
  getVerificationExpiryStatus,
  isSanctionExpired,
  isKycStale,
  isEscalationDue,
  SANCTION_EXPIRY_DAYS,
  KYC_STALE_DAYS,
  KYC_ESCALATION_DAYS,
};
