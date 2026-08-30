const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.PIN_FAILURE_LIMIT = '3';
process.env.PIN_LOCKOUT_MS = '60000';

const { hashPin, verifyPin, verifyPinAttempt, clearPinLock } = require('../src/compliance/pin.service');

const makePrisma = (initialUser) => {
  let user = { ...initialUser };
  return {
    user: {
      findUnique: async ({ where }) => ({ ...user, id: where.id }),
      update: async ({ where, data }) => {
        user = { ...user, ...data };
        return { ...user, id: where.id };
      },
    },
    auditLog: {
      create: async () => ({ ok: true }),
    },
  };
};

test('locks a user after the configured number of failures and blocks a correct PIN while locked', async () => {
  const user = {
    id: 'u_1',
    pinHash: hashPin('123456'),
    pinFailedAttempts: 0,
    pinLockedUntil: null,
  };
  const prisma = makePrisma(user);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await verifyPinAttempt({ prisma, userId: 'u_1', pin: '999999' });
    assert.equal(result.ok, false);
    assert.equal(result.locked, false);
    assert.equal(result.attempts, attempt);
  }

  const lockResult = await verifyPinAttempt({ prisma, userId: 'u_1', pin: '999999' });
  assert.equal(lockResult.ok, false);
  assert.equal(lockResult.locked, true);
  assert.ok(lockResult.retryAfterMs > 0);

  const finalAttempt = await verifyPinAttempt({ prisma, userId: 'u_1', pin: '123456' });
  assert.equal(finalAttempt.ok, false);
  assert.equal(finalAttempt.locked, true);
});

test('clearPinLock resets the lock and the failed-attempt counters', async () => {
  const prisma = makePrisma({
    id: 'u_2',
    pinHash: hashPin('654321'),
    pinFailedAttempts: 3,
    pinLockedUntil: new Date(Date.now() + 60000),
  });

  const cleared = await clearPinLock({ prisma, userId: 'u_2' });
  assert.equal(cleared.pinFailedAttempts, 0);
  assert.equal(cleared.pinLockedUntil, null);
  assert.equal(verifyPin('654321', cleared.pinHash), true);
});
