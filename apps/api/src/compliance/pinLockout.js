'use strict';

/**
 * Exponential PIN Lockout Policy & Security Alerting (#988)
 * ────────────────────────────────────────────────────────
 * Implements exponential delays and notifications against brute-force attacks on 4-digit PINs:
 *   - 3 failed attempts: 5-minute lockout delay
 *   - 5 failed attempts: 30-minute lockout delay
 *   - 7 failed attempts: Manual operator unlock required (indefinite lock)
 *   - Sends security alert notification (SMS/WhatsApp) on lockout transitions
 *   - Provides manual operator unlock mechanism with audit logging
 */

const logger = require('../utils/logger');

const TIER_1_ATTEMPTS = 3;
const TIER_1_LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes

const TIER_2_ATTEMPTS = 5;
const TIER_2_LOCKOUT_MS = 30 * 60 * 1000; // 30 minutes

const TIER_3_ATTEMPTS = 7;
// Indefinite lock timestamp for manual operator unlock
const INDEFINITE_LOCK_DATE = new Date('9999-12-31T23:59:59.999Z');

/**
 * Resolves active lockout thresholds and delays.
 */
const getLockoutConfig = () => ({
  tier1Attempts: Number(process.env.PIN_FAILURE_LIMIT || TIER_1_ATTEMPTS),
  tier1LockoutMs: Number(process.env.PIN_LOCKOUT_TIER1_MS || process.env.PIN_LOCKOUT_MS || TIER_1_LOCKOUT_MS),
  tier2Attempts: TIER_2_ATTEMPTS,
  tier2LockoutMs: Number(process.env.PIN_LOCKOUT_TIER2_MS || TIER_2_LOCKOUT_MS),
  tier3Attempts: TIER_3_ATTEMPTS,
});

/**
 * Calculates lockout status and retry delay based on consecutive failed attempts.
 */
const calculateLockout = (attempts, conf = getLockoutConfig()) => {
  const count = Number(attempts || 0);

  if (count >= conf.tier3Attempts) {
    return {
      locked: true,
      tier: 3,
      requiresOperatorUnlock: true,
      retryAfterMs: Infinity,
      durationMs: null,
      message: 'Account locked due to 7 or more failed PIN attempts. Manual operator unlock required.',
    };
  }

  if (count >= conf.tier2Attempts) {
    return {
      locked: true,
      tier: 2,
      requiresOperatorUnlock: false,
      retryAfterMs: conf.tier2LockoutMs,
      durationMs: conf.tier2LockoutMs,
      message: 'Account locked for 30 minutes due to 5 failed PIN attempts.',
    };
  }

  if (count >= conf.tier1Attempts) {
    return {
      locked: true,
      tier: 1,
      requiresOperatorUnlock: false,
      retryAfterMs: conf.tier1LockoutMs,
      durationMs: conf.tier1LockoutMs,
      message: 'Account locked for 5 minutes due to 3 failed PIN attempts.',
    };
  }

  return {
    locked: false,
    tier: 0,
    requiresOperatorUnlock: false,
    retryAfterMs: 0,
    durationMs: 0,
    message: null,
  };
};

/**
 * Evaluates whether an account is currently locked out.
 */
const checkPinLockStatus = ({ user, now = Date.now(), conf = getLockoutConfig() }) => {
  if (!user) {
    return { isLocked: false, requiresOperatorUnlock: false, remainingMs: 0, attempts: 0 };
  }

  const attempts = Number(user.pinFailedAttempts || 0);

  // Check tier 3 operator unlock condition
  if (attempts >= conf.tier3Attempts) {
    return {
      isLocked: true,
      requiresOperatorUnlock: true,
      remainingMs: Infinity,
      attempts,
    };
  }

  if (user.pinLockedUntil) {
    const lockedUntilTime = new Date(user.pinLockedUntil).getTime();
    if (lockedUntilTime > now) {
      return {
        isLocked: true,
        requiresOperatorUnlock: false,
        remainingMs: lockedUntilTime - now,
        attempts,
      };
    }
    // Lock has expired
    return {
      isLocked: false,
      requiresOperatorUnlock: false,
      remainingMs: 0,
      attempts,
      cooldownExpired: true,
    };
  }

  return {
    isLocked: false,
    requiresOperatorUnlock: false,
    remainingMs: 0,
    attempts,
  };
};

/**
 * Dispatches security alert notifications via WhatsApp and SMS channels.
 */
const sendSecurityAlert = async ({ user, attempts, lockout, db, channel = 'whatsapp' }) => {
  if (!user?.phoneNumber) {
    logger.warn(`[PinLockout] Cannot dispatch security alert for user ${user?.id}: no phone number.`);
    return null;
  }

  let alertMessage;
  if (lockout.requiresOperatorUnlock) {
    alertMessage =
      `Security Alert: Your SendAm account has been locked after ${attempts} failed PIN attempts. ` +
      'For your protection, a manual operator unlock is required. Please contact SendAm support.';
  } else if (lockout.tier === 2) {
    alertMessage =
      `Security Alert: ${attempts} failed PIN attempts detected. Your SendAm account is temporarily ` +
      'locked for 30 minutes. If this was not you, please contact support immediately.';
  } else {
    alertMessage =
      `Security Alert: ${attempts} failed PIN attempts detected. Your SendAm account is temporarily ` +
      'locked for 5 minutes.';
  }

  const alertRecord = {
    userId: user.id,
    type: 'security_alert',
    channel,
    recipient: user.phoneNumber,
    body: alertMessage,
    status: 'queued',
    metadata: {
      attempts,
      tier: lockout.tier,
      requiresOperatorUnlock: lockout.requiresOperatorUnlock,
      retryAfterMs: lockout.retryAfterMs === Infinity ? null : lockout.retryAfterMs,
      sentAt: new Date().toISOString(),
    },
  };

  // 1. Record in database Notification table if available
  if (db?.notification?.create) {
    try {
      await db.notification.create({
        data: {
          userId: user.id,
          channel,
          type: 'security_alert',
          recipient: user.phoneNumber,
          body: alertMessage,
          status: 'queued',
          metadata: alertRecord.metadata,
        },
      });
    } catch (notifErr) {
      logger.warn(`[PinLockout] Failed to persist security alert notification: ${notifErr.message}`);
    }
  }

  logger.warn(
    `[PinLockout] Security alert triggered for user ${user.id} (${user.phoneNumber}) [Tier ${lockout.tier}, ${attempts} attempts]: ${alertMessage}`,
  );

  return alertRecord;
};

/**
 * Manual operator unlock: clears PIN failed attempts and lockout expiration.
 */
const operatorUnlockPin = async ({ prisma, userId, adminId = 'system', reason = 'Manual verification completed' }) => {
  if (!userId) {
    throw Object.assign(new Error('User ID is required for operator unlock'), { statusCode: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw Object.assign(new Error('User not found'), { statusCode: 404 });
  }

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: {
      pinFailedAttempts: 0,
      pinLockedUntil: null,
    },
  });

  const nowIso = new Date().toISOString();

  // Audit operator action
  if (prisma.auditLog?.create) {
    try {
      await prisma.auditLog.create({
        data: {
          actorType: 'administrator',
          actorId: String(adminId),
          action: 'pin_lock_operator_unlocked',
          entityType: 'user',
          entityId: userId,
          metadata: {
            reason,
            unlockedAt: nowIso,
            previousFailedAttempts: user.pinFailedAttempts,
            previousLockedUntil: user.pinLockedUntil,
          },
        },
      });
    } catch (_auditErr) {
      // Non-fatal
    }
  }

  logger.info(`[PinLockout] User ${userId} PIN lock manually cleared by operator ${adminId} (reason: ${reason})`);

  return {
    ...updatedUser,
    success: true,
    userId: updatedUser.id,
    pinFailedAttempts: 0,
    pinLockedUntil: null,
    unlockedAt: nowIso,
  };
};

module.exports = {
  TIER_1_ATTEMPTS,
  TIER_1_LOCKOUT_MS,
  TIER_2_ATTEMPTS,
  TIER_2_LOCKOUT_MS,
  TIER_3_ATTEMPTS,
  INDEFINITE_LOCK_DATE,
  getLockoutConfig,
  calculateLockout,
  checkPinLockStatus,
  sendSecurityAlert,
  operatorUnlockPin,
};
