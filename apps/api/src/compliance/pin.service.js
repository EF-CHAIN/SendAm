const crypto = require('crypto');
const config = require('../config/env');
const {
  calculateLockout,
  checkPinLockStatus,
  sendSecurityAlert,
  operatorUnlockPin,
  INDEFINITE_LOCK_DATE,
} = require('./pinLockout');

const safeTimingEqual = (left, right) => {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const hashPin = (pin) => {
  if (!/^\d{4,6}$/.test(String(pin))) throw new Error('PIN must be 4 to 6 digits.');
  const pepper = config.compliance.pinPepper || config.admin.jwtSecret || 'development-only-pin-pepper';
  return crypto.createHmac('sha256', pepper).update(String(pin)).digest('hex');
};

const verifyPin = (pin, pinHash) => {
  if (!pinHash) return false;
  const expected = hashPin(pin);
  return safeTimingEqual(expected, pinHash);
};

const getPinPolicy = () => ({
  failureLimit: Number(process.env.PIN_FAILURE_LIMIT || config.compliance.pinFailureLimit || 5),
  lockoutMs: Number(process.env.PIN_LOCKOUT_MS || config.compliance.pinLockoutMs || 10 * 60 * 1000),
});

const auditPinEvent = async ({ prisma, userId, action, metadata = {} }) => {
  if (!prisma?.auditLog?.create) return null;
  try {
    return await prisma.auditLog.create({
      data: {
        actorType: 'user',
        actorId: userId,
        action,
        entityType: 'user',
        entityId: userId,
        metadata,
      },
    });
  } catch (_error) {
    return null;
  }
};

const loadUserForUpdate = async ({ prisma, userId }) => {
  if (typeof prisma?.$queryRaw === 'function') {
    try {
      const rows = await prisma.$queryRaw`
        SELECT "id", "pinHash", "pinFailedAttempts", "pinLockedUntil"
        FROM "User"
        WHERE "id" = ${userId}
        FOR UPDATE
      `;
      if (rows && rows.length > 0) {
        const row = rows[0];
        return {
          ...row,
          pinFailedAttempts: Number(row.pinFailedAttempts || 0),
          pinLockedUntil: row.pinLockedUntil ? new Date(row.pinLockedUntil) : null,
        };
      }
    } catch (_error) {
      // Fall through to the standard Prisma read. Some environments (test stubs,
      // SQLite, or locked-down DB clients) do not support the raw FOR UPDATE
      // query even though the rest of the app does.
    }
  }

  return prisma.user.findUnique({ where: { id: userId } });
};

const clearPinLock = async ({ prisma, userId, adminId = 'system', reason = 'Pin lock cleared' }) => {
  return operatorUnlockPin({ prisma, userId, adminId, reason });
};

const verifyPinAttempt = async ({ prisma, userId, pin }) => {
  const current = await loadUserForUpdate({ prisma, userId });
  if (!current) {
    return { ok: false, locked: false, attempts: 0, retryAfterMs: 0 };
  }

  const now = Date.now();
  const lockStatus = checkPinLockStatus({ user: current, now });

  if (lockStatus.isLocked) {
    const retryAfterMs = lockStatus.remainingMs;
    await auditPinEvent({
      prisma,
      userId,
      action: 'pin_lock_blocked',
      metadata: {
        attempts: Number(current.pinFailedAttempts || 0),
        retryAfterMs: retryAfterMs === Infinity ? null : retryAfterMs,
        requiresOperatorUnlock: lockStatus.requiresOperatorUnlock,
      },
    });
    return {
      ok: false,
      locked: true,
      attempts: Number(current.pinFailedAttempts || 0),
      retryAfterMs,
      requiresOperatorUnlock: lockStatus.requiresOperatorUnlock,
    };
  }

  if (!current.pinHash) {
    return { ok: false, locked: false, attempts: Number(current.pinFailedAttempts || 0), retryAfterMs: 0 };
  }

  if (lockStatus.cooldownExpired) {
    await prisma.user.update({
      where: { id: userId },
      data: { pinLockedUntil: null },
    });
  }

  const matches = verifyPin(pin, current.pinHash);
  if (matches) {
    const reset = await prisma.user.update({
      where: { id: userId },
      data: { pinFailedAttempts: 0, pinLockedUntil: null },
    });
    await auditPinEvent({
      prisma,
      userId,
      action: 'pin_verified',
      metadata: { matched: true },
    });
    return { ok: true, locked: false, attempts: 0, retryAfterMs: 0, user: reset };
  }

  const attempts = Number(current.pinFailedAttempts || 0) + 1;
  const lockout = calculateLockout(attempts);
  let lockUntil = null;
  if (lockout.requiresOperatorUnlock) {
    lockUntil = INDEFINITE_LOCK_DATE;
  } else if (lockout.locked) {
    lockUntil = new Date(now + lockout.retryAfterMs);
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      pinFailedAttempts: attempts,
      pinLockedUntil: lockUntil,
    },
  });

  if (lockout.locked) {
    await sendSecurityAlert({ user: current, attempts, lockout, db: prisma }).catch(() => {});
  }

  await auditPinEvent({
    prisma,
    userId,
    action: lockout.locked ? 'pin_lock_activated' : 'pin_attempt_failed',
    metadata: {
      attempts,
      tier: lockout.tier,
      failureLimit: lockout.locked ? attempts : undefined,
      retryAfterMs: lockout.retryAfterMs === Infinity ? null : lockout.retryAfterMs,
      locked: lockout.locked,
      requiresOperatorUnlock: lockout.requiresOperatorUnlock,
      lockUntil: lockUntil ? lockUntil.toISOString() : null,
    },
  });

  return {
    ok: false,
    locked: lockout.locked,
    attempts,
    retryAfterMs: lockout.retryAfterMs,
    requiresOperatorUnlock: lockout.requiresOperatorUnlock,
    user: updated,
  };
};

module.exports = {
  hashPin,
  verifyPin,
  clearPinLock,
  verifyPinAttempt,
  getPinPolicy,
  operatorUnlockPin,
  calculateLockout,
  checkPinLockStatus,
  sendSecurityAlert,
};
