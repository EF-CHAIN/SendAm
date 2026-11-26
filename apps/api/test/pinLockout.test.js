'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Clear environment overrides so default exponential policy (3, 5, 7) is tested
delete process.env.PIN_FAILURE_LIMIT;
delete process.env.PIN_LOCKOUT_MS;
delete process.env.PIN_LOCKOUT_TIER1_MS;
delete process.env.PIN_LOCKOUT_TIER2_MS;

const {
  calculateLockout,
  checkPinLockStatus,
  sendSecurityAlert,
  operatorUnlockPin,
} = require('../src/compliance/pinLockout');

const { hashPin, verifyPinAttempt } = require('../src/compliance/pin.service');

const makeMockDb = (initialUser = {}) => {
  let user = {
    id: 'user_pin_lockout_test',
    phoneNumber: '+2348123456789',
    pinHash: hashPin('1234'),
    pinFailedAttempts: 0,
    pinLockedUntil: null,
    ...initialUser,
  };

  const auditLogs = [];
  const notifications = [];

  return {
    user: {
      findUnique: async ({ where }) => (user.id === where.id ? { ...user } : null),
      update: async ({ where, data }) => {
        if (user.id === where.id) {
          user = { ...user, ...data };
          return { ...user };
        }
        return null;
      },
    },
    auditLog: {
      create: async ({ data }) => {
        auditLogs.push(data);
        return { id: `audit_${auditLogs.length}`, ...data };
      },
    },
    notification: {
      create: async ({ data }) => {
        notifications.push(data);
        return { id: `notif_${notifications.length}`, ...data };
      },
    },
    _getUser: () => user,
    _getAuditLogs: () => auditLogs,
    _getNotifications: () => notifications,
  };
};

test('calculateLockout calculates exponential lockout tiers accurately', () => {
  // 0-2 attempts: no lockout
  for (let i = 0; i < 3; i += 1) {
    const res = calculateLockout(i);
    assert.equal(res.locked, false);
    assert.equal(res.tier, 0);
    assert.equal(res.requiresOperatorUnlock, false);
    assert.equal(res.retryAfterMs, 0);
  }

  // Tier 1: 3-4 attempts: 5 minutes lockout
  const t1 = calculateLockout(3);
  assert.equal(t1.locked, true);
  assert.equal(t1.tier, 1);
  assert.equal(t1.requiresOperatorUnlock, false);
  assert.equal(t1.retryAfterMs, 5 * 60 * 1000); // 300,000 ms

  const t1_4 = calculateLockout(4);
  assert.equal(t1_4.locked, true);
  assert.equal(t1_4.tier, 1);
  assert.equal(t1_4.retryAfterMs, 5 * 60 * 1000);

  // Tier 2: 5-6 attempts: 30 minutes lockout
  const t2 = calculateLockout(5);
  assert.equal(t2.locked, true);
  assert.equal(t2.tier, 2);
  assert.equal(t2.requiresOperatorUnlock, false);
  assert.equal(t2.retryAfterMs, 30 * 60 * 1000); // 1,800,000 ms

  const t2_6 = calculateLockout(6);
  assert.equal(t2_6.locked, true);
  assert.equal(t2_6.tier, 2);
  assert.equal(t2_6.retryAfterMs, 30 * 60 * 1000);

  // Tier 3: 7+ attempts: manual operator unlock required
  const t3 = calculateLockout(7);
  assert.equal(t3.locked, true);
  assert.equal(t3.tier, 3);
  assert.equal(t3.requiresOperatorUnlock, true);
  assert.equal(t3.retryAfterMs, Infinity);

  const t3_10 = calculateLockout(10);
  assert.equal(t3_10.locked, true);
  assert.equal(t3_10.tier, 3);
  assert.equal(t3_10.requiresOperatorUnlock, true);
});

test('checkPinLockStatus detects locked state, remaining time, and cooldown expiration', () => {
  const now = 1000000;

  // Unlocked user
  const unlocked = checkPinLockStatus({
    user: { pinFailedAttempts: 1, pinLockedUntil: null },
    now,
  });
  assert.equal(unlocked.isLocked, false);
  assert.equal(unlocked.remainingMs, 0);

  // Locked user (Tier 1: 5 mins remaining)
  const lockedUser = {
    pinFailedAttempts: 3,
    pinLockedUntil: new Date(now + 300000),
  };
  const activeLock = checkPinLockStatus({ user: lockedUser, now });
  assert.equal(activeLock.isLocked, true);
  assert.equal(activeLock.remainingMs, 300000);
  assert.equal(activeLock.requiresOperatorUnlock, false);

  // Cooldown expired
  const expiredUser = {
    pinFailedAttempts: 3,
    pinLockedUntil: new Date(now - 1000),
  };
  const expiredLock = checkPinLockStatus({ user: expiredUser, now });
  assert.equal(expiredLock.isLocked, false);
  assert.equal(expiredLock.remainingMs, 0);
  assert.equal(expiredLock.cooldownExpired, true);

  // Tier 3 user requires operator unlock regardless of timestamp
  const operatorRequiredUser = {
    pinFailedAttempts: 7,
    pinLockedUntil: null,
  };
  const opLock = checkPinLockStatus({ user: operatorRequiredUser, now });
  assert.equal(opLock.isLocked, true);
  assert.equal(opLock.requiresOperatorUnlock, true);
  assert.equal(opLock.remainingMs, Infinity);
});

test('sendSecurityAlert constructs tailored messages and queues notifications', async () => {
  const db = makeMockDb();
  const user = db._getUser();

  // Tier 1 alert (3 attempts)
  const alert1 = await sendSecurityAlert({
    user,
    attempts: 3,
    lockout: { tier: 1, requiresOperatorUnlock: false, retryAfterMs: 300000 },
    db,
  });
  assert.ok(alert1.body.includes('5 minutes'));
  assert.equal(alert1.type, 'security_alert');
  assert.equal(alert1.recipient, '+2348123456789');

  // Tier 2 alert (5 attempts)
  const alert2 = await sendSecurityAlert({
    user,
    attempts: 5,
    lockout: { tier: 2, requiresOperatorUnlock: false, retryAfterMs: 1800000 },
    db,
  });
  assert.ok(alert2.body.includes('30 minutes'));

  // Tier 3 alert (7 attempts)
  const alert3 = await sendSecurityAlert({
    user,
    attempts: 7,
    lockout: { tier: 3, requiresOperatorUnlock: true, retryAfterMs: Infinity },
    db,
  });
  assert.ok(alert3.body.includes('manual operator unlock is required'));

  // Verify persistence in DB notifications
  const notifs = db._getNotifications();
  assert.equal(notifs.length, 3);
  assert.equal(notifs[0].type, 'security_alert');
  assert.equal(notifs[0].recipient, '+2348123456789');
});

test('verifyPinAttempt enforces Tier 1 (5 min lockout) after 3 failed attempts and dispatches security alert', async () => {
  const db = makeMockDb();

  // First 2 failed attempts: not locked
  for (let i = 1; i <= 2; i += 1) {
    const res = await verifyPinAttempt({ prisma: db, userId: 'user_pin_lockout_test', pin: '0000' });
    assert.equal(res.ok, false);
    assert.equal(res.locked, false);
    assert.equal(res.attempts, i);
  }

  // 3rd failed attempt: triggers Tier 1 (5 mins lockout)
  const thirdAttempt = await verifyPinAttempt({ prisma: db, userId: 'user_pin_lockout_test', pin: '0000' });
  assert.equal(thirdAttempt.ok, false);
  assert.equal(thirdAttempt.locked, true);
  assert.equal(thirdAttempt.attempts, 3);
  assert.equal(thirdAttempt.retryAfterMs, 5 * 60 * 1000);

  // Security alert was recorded in DB
  const notifs = db._getNotifications();
  assert.equal(notifs.length, 1);
  assert.match(notifs[0].body, /5 minutes/);

  // While locked: even correct PIN is rejected immediately
  const blockedAttempt = await verifyPinAttempt({ prisma: db, userId: 'user_pin_lockout_test', pin: '1234' });
  assert.equal(blockedAttempt.ok, false);
  assert.equal(blockedAttempt.locked, true);
  assert.ok(blockedAttempt.retryAfterMs > 0);
});

test('verifyPinAttempt enforces Tier 2 (30 min lockout) after 5 failed attempts', async () => {
  // Simulate user with 4 failed attempts whose previous cooldown expired
  const db = makeMockDb({
    pinFailedAttempts: 4,
    pinLockedUntil: new Date(Date.now() - 10000), // expired cooldown
  });

  // 5th failed attempt: triggers Tier 2 (30 mins lockout)
  const fifthAttempt = await verifyPinAttempt({ prisma: db, userId: 'user_pin_lockout_test', pin: '9999' });
  assert.equal(fifthAttempt.ok, false);
  assert.equal(fifthAttempt.locked, true);
  assert.equal(fifthAttempt.attempts, 5);
  assert.equal(fifthAttempt.retryAfterMs, 30 * 60 * 1000);

  // Verify alert for Tier 2 (30 mins)
  const notifs = db._getNotifications();
  assert.equal(notifs.length, 1);
  assert.match(notifs[0].body, /30 minutes/);
});

test('verifyPinAttempt enforces Tier 3 (indefinite lock requiring operator unlock) after 7 failed attempts', async () => {
  // Simulate user with 6 failed attempts whose cooldown expired
  const db = makeMockDb({
    pinFailedAttempts: 6,
    pinLockedUntil: new Date(Date.now() - 10000),
  });

  // 7th failed attempt: triggers Tier 3
  const seventhAttempt = await verifyPinAttempt({ prisma: db, userId: 'user_pin_lockout_test', pin: '9999' });
  assert.equal(seventhAttempt.ok, false);
  assert.equal(seventhAttempt.locked, true);
  assert.equal(seventhAttempt.attempts, 7);
  assert.equal(seventhAttempt.requiresOperatorUnlock, true);

  // Alert for operator unlock
  const notifs = db._getNotifications();
  assert.equal(notifs.length, 1);
  assert.match(notifs[0].body, /manual operator unlock/i);

  // Attempt after a simulated 10 days still blocked without operator unlock
  const user = db._getUser();
  user.pinLockedUntil = new Date(Date.now() - 100000000); // even if timestamp was in past
  const blockedAttempt = await verifyPinAttempt({ prisma: db, userId: 'user_pin_lockout_test', pin: '1234' });
  assert.equal(blockedAttempt.ok, false);
  assert.equal(blockedAttempt.locked, true);
  assert.equal(blockedAttempt.requiresOperatorUnlock, true);
});

test('operatorUnlockPin resets failed attempts and clears lockout', async () => {
  const db = makeMockDb({
    pinFailedAttempts: 7,
    pinLockedUntil: new Date('9999-12-31T23:59:59.999Z'),
  });

  // Operator unlocks the account
  const unlockResult = await operatorUnlockPin({
    prisma: db,
    userId: 'user_pin_lockout_test',
    adminId: 'admin_ops_1',
    reason: 'Customer identity verified via video KYC',
  });

  assert.equal(unlockResult.success, true);
  assert.equal(unlockResult.pinFailedAttempts, 0);
  assert.equal(unlockResult.pinLockedUntil, null);

  // Audit log recorded
  const audits = db._getAuditLogs();
  const unlockAudit = audits.find((a) => a.action === 'pin_lock_operator_unlocked');
  assert.ok(unlockAudit);
  assert.equal(unlockAudit.actorId, 'admin_ops_1');
  assert.equal(unlockAudit.metadata.reason, 'Customer identity verified via video KYC');

  // User can immediately verify correct PIN now
  const successAttempt = await verifyPinAttempt({ prisma: db, userId: 'user_pin_lockout_test', pin: '1234' });
  assert.equal(successAttempt.ok, true);
  assert.equal(successAttempt.locked, false);
  assert.equal(successAttempt.attempts, 0);
});
