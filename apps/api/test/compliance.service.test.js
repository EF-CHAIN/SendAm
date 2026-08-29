const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const injectMock = (relativeFromSrc, factory) => {
  const abs = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[abs] = {
    id: abs,
    filename: abs,
    loaded: true,
    exports: factory(),
  };
};

const mockFindUnique = async () => null;
const mockCreate = async (input) => ({ id: 'profile_1', ...input.data });
const mockUpdate = async ({ where, data }) => ({ id: where.id || 'profile_1', ...data });
const prismaMock = {
  kycProfile: {
    findUnique: mockFindUnique,
    create: mockCreate,
    update: mockUpdate,
  },
  transaction: {
    findMany: async () => [],
  },
  sanctionsScreeningResult: {
    create: async (input) => ({ id: 'screening_1', ...input.data }),
  },
  auditLog: {
    create: async () => ({ id: 'audit_1' }),
  },
};

injectMock('common/prisma', () => prismaMock);
injectMock('config/env', () => ({ 
  compliance: { 
    provider: 'smileid',
    screeningProvider: 'static',  // Use static provider for tests
    screeningMaxAgeMs: 24 * 60 * 60 * 1000,
    screeningMaxStalenessMs: 72 * 60 * 60 * 1000,
  } 
}));

const { getOrCreateKycProfile, enforceTransactionPolicy, calculateRiskScore, screenSanctions } = require('../src/compliance/compliance.service');

const user = { id: 'user_1', phoneNumber: '+1234567890', kycTier: 1, firstName: 'Test', lastName: 'User' };

const resetPrisma = () => {
  prismaMock.kycProfile.findUnique = mockFindUnique;
  prismaMock.kycProfile.create = mockCreate;
  prismaMock.kycProfile.update = mockUpdate;
  prismaMock.transaction.findMany = async () => [];
  prismaMock.sanctionsScreeningResult.create = async (input) => ({ id: 'screening_1', ...input.data });
  prismaMock.auditLog.create = async () => ({ id: 'audit_1' });
};

test('getOrCreateKycProfile creates a profile when none exists', async () => {
  resetPrisma();
  const profile = await getOrCreateKycProfile(user);
  assert.equal(profile.userId, user.id);
  assert.equal(profile.provider, 'smileid');
  assert.equal(profile.tier, 1);
  assert.equal(profile.status, 'approved');
  assert.equal(profile.sanctionsStatus, 'not_screened');
  assert.equal(profile.custodyStatus, 'not_reviewed');
});

test('calculateRiskScore includes profile risk and cross-border risk', () => {
  const score = calculateRiskScore({ amount: '80000', routeType: 'cross_border', destinationCountry: 'US', profileRiskScore: 20 });
  assert.ok(score >= 80, 'score should reach manual review threshold');
});

test('enforceTransactionPolicy rejects if KYC not approved', async () => {
  resetPrisma();
  prismaMock.kycProfile.findUnique = async () => ({ id: 'profile_2', userId: user.id, provider: 'smileid', tier: 0, status: 'pending', sanctionsStatus: 'not_screened', custodyStatus: 'not_reviewed' });
  await assert.rejects(
    () => enforceTransactionPolicy({ user, amount: '100', routeType: 'domestic', destinationCountry: 'NG' }),
    { message: 'KYC approval is required before sending money.' },
  );
});

test('enforceTransactionPolicy rejects blocked sanctions destination', async () => {
  resetPrisma();
  prismaMock.kycProfile.findUnique = async () => ({ id: 'profile_3', userId: user.id, provider: 'smileid', tier: 1, status: 'approved', sanctionsStatus: 'not_screened', custodyStatus: 'not_reviewed' });
  await assert.rejects(
    () => enforceTransactionPolicy({ user, amount: '100', routeType: 'domestic', destinationCountry: 'IR' }),
    { message: 'Country IR is on the static blocked list.' },
  );
});

test('enforceTransactionPolicy rejects review sanctions destination', async () => {
  resetPrisma();
  let updated;
  prismaMock.kycProfile.findUnique = async () => ({ id: 'profile_4', userId: user.id, provider: 'smileid', tier: 1, status: 'approved', sanctionsStatus: 'not_screened', custodyStatus: 'not_reviewed' });
  prismaMock.kycProfile.update = async ({ where, data }) => { updated = data; return { id: where.id, ...data }; };

  await assert.rejects(
    () => enforceTransactionPolicy({ user, amount: '100', routeType: 'domestic', destinationCountry: 'RU' }),
    { message: /manual compliance review/ },
  );
  assert.equal(updated.sanctionsStatus, 'review');
});


test('enforceTransactionPolicy totals only transactions in the requested asset', async () => {
  resetPrisma();
  let where;
  prismaMock.kycProfile.findUnique = async () => ({ id: 'profile_5', userId: user.id, provider: 'smileid', tier: 1, status: 'approved', sanctionsStatus: 'cleared', custodyStatus: 'not_reviewed' });
  prismaMock.transaction.findMany = async (query) => {
    where = query.where;
    return [{ amount: '19999.0000000', asset: 'USDC' }];
  };

  await enforceTransactionPolicy({ user, amount: '1.0000000', asset: 'USDC', routeType: 'domestic', destinationCountry: 'NG' });

  assert.equal(where.asset, 'USDC');
});
