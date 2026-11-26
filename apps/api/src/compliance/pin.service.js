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
const crypto = require('crypto');
const argon2 = require('argon2');
const config = require('../config/env');

const OWASP_ARGON2_PARAMS = {
  type: argon2.argon2id,
  memoryCost: Number(process.env.ARGON2_MEMORY_COST || 65536), // 65536 KiB (64 MiB)
  timeCost: Number(process.env.ARGON2_TIME_COST || 3),         // 3 iterations
  parallelism: Number(process.env.ARGON2_PARALLELISM || 1),   // 1 thread
};

const getArgon2Options = () => ({
  type: OWASP_ARGON2_PARAMS.type,
  memoryCost: Number(process.env.ARGON2_MEMORY_COST || OWASP_ARGON2_PARAMS.memoryCost),
  timeCost: Number(process.env.ARGON2_TIME_COST || OWASP_ARGON2_PARAMS.timeCost),
  parallelism: Number(process.env.ARGON2_PARALLELISM || OWASP_ARGON2_PARAMS.parallelism),
});

const getPepper = () =>
  config.compliance.pinPepper || config.admin.jwtSecret || 'development-only-pin-pepper';

const safeTimingEqual = (left, right) => {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    // Constant-time dummy comparison to prevent side-channel timing leaks on length
    crypto.timingSafeEqual(leftBuffer, leftBuffer);
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const isArgon2Hash = (hash) => {
  return (
    typeof hash === 'string' &&
    (hash.startsWith('$argon2id$') ||
      hash.startsWith('$argon2i$') ||
      hash.startsWith('$argon2d$'))
  );
};

const hashLegacyPin = (pin) => {
  if (!/^\d{4,6}$/.test(String(pin))) throw new Error('PIN must be 4 to 6 digits.');
  const pepper = getPepper();
  return crypto.createHmac('sha256', pepper).update(String(pin)).digest('hex');
};

const hashPin = async (pin, customOptions = {}) => {
  if (!/^\d{4,6}$/.test(String(pin))) throw new Error('PIN must be 4 to 6 digits.');
  const pepper = getPepper();
  const options = {
    ...getArgon2Options(),
    ...customOptions,
  };
  if (pepper) {
    options.secret = Buffer.from(pepper);
  }
  return argon2.hash(String(pin), options);
};

const needsUpgrade = (pinHash) => {
  if (!pinHash) return false;
  if (!isArgon2Hash(pinHash)) return true;
  try {
    return argon2.needsRehash(pinHash, getArgon2Options());
  } catch {
    return false;
  }
};

const verifyPin = async (pin, pinHash) => {
  if (pinHash && typeof pinHash.then === 'function') {
    pinHash = await pinHash;
  }
  if (!pinHash || typeof pinHash !== 'string') return false;

  const pinStr = String(pin);

  // Argon2id verification
  if (isArgon2Hash(pinHash)) {
    const pepper = getPepper();
    try {
      const options = pepper ? { secret: Buffer.from(pepper) } : {};
      return await argon2.verify(pinHash, pinStr, options);
    } catch (_err) {
      // In case hash was created without secret or with legacy pepper
      try {
        return await argon2.verify(pinHash, pinStr);
      } catch (_e) {
        return false;
      }
    }
  }

  // Legacy verification (HMAC-SHA256)
  try {
    const legacyExpected = hashLegacyPin(pinStr);
    return safeTimingEqual(legacyExpected, pinHash);
  } catch (_e) {
    return false;
  }
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

  // Handle case where pinHash was passed as a Promise in a mock
  if (current.pinHash && typeof current.pinHash.then === 'function') {
    current.pinHash = await current.pinHash;
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

  const matches = await verifyPin(pin, current.pinHash);
  if (matches) {
    let upgradedHash = null;
    if (needsUpgrade(current.pinHash)) {
      try {
        upgradedHash = await hashPin(pin);
      } catch (upgradeErr) {
        console.warn('[pin.service] Failed to auto-upgrade legacy PIN hash:', upgradeErr.message);
      }
    }

    const updateData = {
      pinFailedAttempts: 0,
      pinLockedUntil: null,
      ...(upgradedHash ? { pinHash: upgradedHash } : {}),
    };

    const reset = await prisma.user.update({
      where: { id: userId },
      data: updateData,
    });

    await auditPinEvent({
      prisma,
      userId,
      action: upgradedHash ? 'pin_verified_and_upgraded' : 'pin_verified',
      metadata: { matched: true, upgraded: Boolean(upgradedHash) },
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
  hashLegacyPin,
  isArgon2Hash,
  needsUpgrade,
  verifyPin,
  clearPinLock,
  verifyPinAttempt,
  getPinPolicy,
  OWASP_ARGON2_PARAMS,
};
