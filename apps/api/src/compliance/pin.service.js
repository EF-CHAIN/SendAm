const crypto = require('crypto');
const config = require('../config/env');

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
  } catch (error) {
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

const clearPinLock = async ({ prisma, userId }) => {
  const current = await loadUserForUpdate({ prisma, userId });
  if (!current) return null;

  const cleared = await prisma.user.update({
    where: { id: userId },
    data: {
      pinFailedAttempts: 0,
      pinLockedUntil: null,
    },
  });

  await auditPinEvent({
    prisma,
    userId,
    action: 'pin_lock_cleared',
    metadata: { userId, clearedAt: new Date().toISOString() },
  });

  return cleared;
};

const verifyPinAttempt = async ({ prisma, userId, pin }) => {
  const current = await loadUserForUpdate({ prisma, userId });
  if (!current) {
    return { ok: false, locked: false, attempts: 0, retryAfterMs: 0 };
  }

  const policy = getPinPolicy();
  const now = Date.now();
  const lockedUntil = current.pinLockedUntil ? new Date(current.pinLockedUntil).getTime() : null;

  if (lockedUntil && lockedUntil > now) {
    const retryAfterMs = lockedUntil - now;
    await auditPinEvent({
      prisma,
      userId,
      action: 'pin_lock_blocked',
      metadata: { attempts: Number(current.pinFailedAttempts || 0), retryAfterMs },
    });
    return { ok: false, locked: true, attempts: Number(current.pinFailedAttempts || 0), retryAfterMs };
  }

  if (!current.pinHash) {
    return { ok: false, locked: false, attempts: Number(current.pinFailedAttempts || 0), retryAfterMs: 0 };
  }

  if (lockedUntil && lockedUntil <= now) {
    await prisma.user.update({
      where: { id: userId },
      data: { pinFailedAttempts: 0, pinLockedUntil: null },
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
  const shouldLock = attempts >= policy.failureLimit;
  const retryAfterMs = shouldLock ? policy.lockoutMs : 0;
  const lockUntil = shouldLock ? new Date(now + retryAfterMs) : null;

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      pinFailedAttempts: attempts,
      pinLockedUntil: lockUntil,
    },
  });

  await auditPinEvent({
    prisma,
    userId,
    action: shouldLock ? 'pin_lock_activated' : 'pin_attempt_failed',
    metadata: {
      attempts,
      failureLimit: policy.failureLimit,
      retryAfterMs,
      locked: shouldLock,
      lockUntil: lockUntil ? lockUntil.toISOString() : null,
    },
  });

  return {
    ok: false,
    locked: shouldLock,
    attempts,
    retryAfterMs,
    user: updated,
  };
};

module.exports = {
  hashPin,
  verifyPin,
  clearPinLock,
  verifyPinAttempt,
  getPinPolicy,
};
