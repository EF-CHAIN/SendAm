const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.PIN_FAILURE_LIMIT = '3';
process.env.PIN_LOCKOUT_MS = '60000';

const {
  hashPin,
  hashLegacyPin,
  isArgon2Hash,
  needsUpgrade,
  verifyPin,
  verifyPinAttempt,
  clearPinLock,
  OWASP_ARGON2_PARAMS,
} = require('../src/compliance/pin.service');

const makePrisma = (initialUser) => {
  let user = { ...initialUser };
  const auditLogs = [];
  return {
    user: {
      findUnique: async ({ where }) => ({ ...user, id: where.id }),
      update: async ({ where, data }) => {
        user = { ...user, ...data };
        return { ...user, id: where.id };
      },
    },
    auditLog: {
      create: async ({ data }) => {
        auditLogs.push(data);
        return { id: `audit_${auditLogs.length}`, ...data };
      },
    },
    getAuditLogs: () => auditLogs,
    getUser: () => user,
  };
};

test('Argon2id default parameters match OWASP recommendations', () => {
  assert.equal(OWASP_ARGON2_PARAMS.memoryCost, 65536);
  assert.equal(OWASP_ARGON2_PARAMS.timeCost, 3);
  assert.equal(OWASP_ARGON2_PARAMS.parallelism, 1);
});

test('hashPin produces a valid Argon2id hash with memory-hardness and salt', async () => {
  const hash = await hashPin('1234');
  assert.equal(typeof hash, 'string');
  assert.ok(hash.startsWith('$argon2id$'), `Expected hash to start with $argon2id$, got: ${hash}`);
  assert.ok(hash.includes('m=65536'), `Expected m=65536, got: ${hash}`);
  assert.ok(hash.includes('t=3'), `Expected t=3, got: ${hash}`);
  assert.ok(hash.includes('p=1'), `Expected p=1, got: ${hash}`);
  assert.equal(isArgon2Hash(hash), true);
});

test('hashPin enforces 4 to 6 digits', async () => {
  await assert.rejects(async () => hashPin('12'), /PIN must be 4 to 6 digits/);
  await assert.rejects(async () => hashPin('1234567'), /PIN must be 4 to 6 digits/);
  await assert.rejects(async () => hashPin('abcd'), /PIN must be 4 to 6 digits/);
});

test('verifyPin accurately verifies Argon2id hashes and rejects wrong PINs', async () => {
  const hash = await hashPin('5678');
  assert.equal(await verifyPin('5678', hash), true);
  assert.equal(await verifyPin('5679', hash), false);
  assert.equal(await verifyPin('0000', hash), false);
  assert.equal(await verifyPin('', hash), false);
  assert.equal(await verifyPin('5678', null), false);
});

test('verifyPin verifies legacy HMAC-SHA256 hashes for backward compatibility', async () => {
  const legacyHash = hashLegacyPin('4321');
  assert.ok(!isArgon2Hash(legacyHash));
  assert.equal(needsUpgrade(legacyHash), true);

  assert.equal(await verifyPin('4321', legacyHash), true);
  assert.equal(await verifyPin('0000', legacyHash), false);
});

test('auto-upgrades legacy hash to Argon2id upon successful verifyPinAttempt', async () => {
  const legacyHash = hashLegacyPin('123456');
  const prisma = makePrisma({
    id: 'u_upgrade',
    pinHash: legacyHash,
    pinFailedAttempts: 0,
    pinLockedUntil: null,
  });

  const result = await verifyPinAttempt({ prisma, userId: 'u_upgrade', pin: '123456' });
  assert.equal(result.ok, true);
  assert.equal(result.locked, false);

  const updatedUser = prisma.getUser();
  assert.notEqual(updatedUser.pinHash, legacyHash);
  assert.ok(isArgon2Hash(updatedUser.pinHash), `Expected Argon2 hash, got ${updatedUser.pinHash}`);
  assert.equal(needsUpgrade(updatedUser.pinHash), false);

  // Subsequent verification works with the newly upgraded Argon2id hash
  const secondResult = await verifyPinAttempt({ prisma, userId: 'u_upgrade', pin: '123456' });
  assert.equal(secondResult.ok, true);

  const logs = prisma.getAuditLogs();
  const upgradeLog = logs.find((l) => l.action === 'pin_verified_and_upgraded');
  assert.ok(upgradeLog, 'Audit log should record pin_verified_and_upgraded');
  assert.equal(upgradeLog.metadata.upgraded, true);
});

test('does NOT upgrade hash when verifyPinAttempt fails', async () => {
  const legacyHash = hashLegacyPin('123456');
  const prisma = makePrisma({
    id: 'u_no_upgrade',
    pinHash: legacyHash,
    pinFailedAttempts: 0,
    pinLockedUntil: null,
  });

  const result = await verifyPinAttempt({ prisma, userId: 'u_no_upgrade', pin: '000000' });
  assert.equal(result.ok, false);

  const userAfter = prisma.getUser();
  assert.equal(userAfter.pinHash, legacyHash);
});

test('locks a user after the configured number of failures and blocks a correct PIN while locked', async () => {
  const hash = await hashPin('123456');
  const user = {
    id: 'u_1',
    pinHash: hash,
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
  const hash = await hashPin('654321');
  const prisma = makePrisma({
    id: 'u_2',
    pinHash: hash,
    pinFailedAttempts: 3,
    pinLockedUntil: new Date(Date.now() + 60000),
  });

  const cleared = await clearPinLock({ prisma, userId: 'u_2' });
  assert.equal(cleared.pinFailedAttempts, 0);
  assert.equal(cleared.pinLockedUntil, null);
  assert.equal(await verifyPin('654321', cleared.pinHash), true);
});
