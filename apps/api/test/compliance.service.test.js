const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { convert } = require('../src/utils/money');

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
injectMock('utils/logger', () => ({ info: () => {}, error: () => {} }));
injectMock('compliance/smileId.provider', () => ({
  submitVerification: async () => {},
  verifyCallback: () => true,
}));
injectMock('config/env', () => ({
  compliance: {
    provider: 'smileid',
    policyCurrency: 'NGN',
    policyVersion: '1',
    policyFxMaxAgeMs: 300000,
    tierLimits: {
      0: { daily: '0.00', single: '0.00' },
      1: { daily: '50000.00', single: '20000.00' },
      2: { daily: '500000.00', single: '200000.00' },
      3: { daily: '5000000.00', single: '1000000.00' },
    },
  },
  pricing: {
    exchangeRateApiKey: 'test-fx-key',
    coinGeckoApiKey: 'test-cg-key',
  },
}));

const {
  getOrCreateKycProfile,
  enforceTransactionPolicy,
  calculateRiskScore,
  POLICY_ERROR_CODES,
} = require('../src/compliance/compliance.service');

const user = { id: 'user_1', phoneNumber: '+1234567890', kycTier: 1 };
const now = new Date('2026-08-28T09:00:00.000Z');

const approvedProfile = (overrides = {}) => ({
  id: 'profile_ok',
  userId: user.id,
  provider: 'smileid',
  tier: 1,
  status: 'approved',
  sanctionsStatus: 'cleared',
  custodyStatus: 'not_reviewed',
  riskScore: 0,
  ...overrides,
});

const resetPrisma = () => {
  prismaMock.kycProfile.findUnique = mockFindUnique;
  prismaMock.kycProfile.create = mockCreate;
  prismaMock.kycProfile.update = mockUpdate;
  prismaMock.transaction.findMany = async () => [];
  prismaMock.sanctionsScreeningResult.create = async (input) => ({ id: 'screening_1', ...input.data });
  prismaMock.auditLog.create = async () => ({ id: 'audit_1' });
};

const usdcRate = async () => ({ rate: '1550.00', fetchedAt: now });
const xlmRates = {
  fetchCryptoUsdRate: async () => ({ rate: '0.20', fetchedAt: now }),
  fetchFiatRate: async () => ({ rate: '1550.00', fetchedAt: now }),
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

test('calculateRiskScore amount bands use NGN, not settlement-asset units', () => {
  assert.equal(calculateRiskScore({ amount: '50000.00', asset: 'NGN', routeType: 'domestic', destinationCountry: 'NG' }), 10);
  assert.equal(calculateRiskScore({ amount: '50000.01', asset: 'NGN', routeType: 'domestic', destinationCountry: 'NG' }), 20);
  assert.equal(calculateRiskScore({ amount: '100000.01', asset: 'NGN', routeType: 'domestic', destinationCountry: 'NG' }), 50);
  const xlmNativeMisread = calculateRiskScore({
    amount: convert({ amount: '50000.0000000', sourceAsset: 'XLM', targetAsset: 'NGN', rate: '0.50' }),
    asset: 'NGN',
    routeType: 'domestic',
    destinationCountry: 'NG',
  });
  assert.equal(xlmNativeMisread, 10);
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

test('fiat-routed NGN payments compare limits in NGN without FX', async () => {
  resetPrisma();
  prismaMock.kycProfile.findUnique = async () => approvedProfile();
  prismaMock.kycProfile.update = async ({ where, data }) => ({ id: where.id, ...approvedProfile(), ...data });

  const result = await enforceTransactionPolicy({
    user,
    amount: '15000.00',
    asset: 'NGN',
    routeType: 'domestic',
    destinationCountry: 'NG',
    now,
  });
  assert.equal(result.policySnapshot.source, 'identity');
  assert.equal(result.policySnapshot.convertedAmount, '15000.00');
  assert.equal(result.riskScore, 10);
});

test('economically equivalent USDC and XLM receive the same limit and risk treatment', async () => {
  resetPrisma();
  prismaMock.kycProfile.findUnique = async () => approvedProfile();
  prismaMock.kycProfile.update = async ({ where, data }) => ({ id: where.id, ...approvedProfile(), ...data });

  const usdc = await enforceTransactionPolicy({
    user,
    amount: '1.0000000',
    asset: 'USDC',
    routeType: 'domestic',
    destinationCountry: 'NG',
    now,
    fetchFiatRate: usdcRate,
  });
  const xlm = await enforceTransactionPolicy({
    user,
    amount: '5.0000000',
    asset: 'XLM',
    routeType: 'domestic',
    destinationCountry: 'NG',
    now,
    ...xlmRates,
  });

  assert.equal(usdc.policySnapshot.convertedAmount, '1550.00');
  assert.equal(xlm.policySnapshot.convertedAmount, '1550.00');
  assert.equal(usdc.riskScore, xlm.riskScore);
});

test('enforceTransactionPolicy aggregates daily totals across assets in NGN', async () => {
  resetPrisma();
  let where;
  prismaMock.kycProfile.findUnique = async () => approvedProfile();
  prismaMock.kycProfile.update = async ({ where: w, data }) => ({ id: w.id, ...approvedProfile(), ...data });
  prismaMock.transaction.findMany = async (query) => {
    where = query.where;
    return [{
      amount: '19.3548387',
      asset: 'USDC',
      fiatAmount: '30000.00',
      fiatCurrency: 'NGN',
    }];
  };

  const allowed = await enforceTransactionPolicy({
    user,
    amount: '12.9032258',
    asset: 'USDC',
    routeType: 'domestic',
    destinationCountry: 'NG',
    now,
    fetchFiatRate: usdcRate,
  });
  assert.equal(where.asset, undefined);
  assert.equal(where.type, 'send');
  assert.equal(allowed.policySnapshot.convertedAmount, '20000.00');

  prismaMock.transaction.findMany = async () => [{
    amount: '19.3548452',
    asset: 'XLM',
    fiatAmount: '30000.01',
    fiatCurrency: 'NGN',
  }];

  await assert.rejects(
    () => enforceTransactionPolicy({
      user,
      amount: '12.9032258',
      asset: 'USDC',
      routeType: 'domestic',
      destinationCountry: 'NG',
      now,
      fetchFiatRate: usdcRate,
    }),
    { message: 'This payment exceeds your tier 1 daily limit.' },
  );
});

test('single-limit boundary uses converted NGN cents', async () => {
  resetPrisma();
  prismaMock.kycProfile.findUnique = async () => approvedProfile();
  prismaMock.kycProfile.update = async ({ where, data }) => ({ id: where.id, ...approvedProfile(), ...data });

  const allowed = await enforceTransactionPolicy({
    user,
    amount: '12.9032258',
    asset: 'USDC',
    routeType: 'domestic',
    destinationCountry: 'NG',
    now,
    fetchFiatRate: usdcRate,
  });
  assert.equal(allowed.policySnapshot.convertedAmount, '20000.00');

  await assert.rejects(
    () => enforceTransactionPolicy({
      user,
      amount: '12.9032323',
      asset: 'USDC',
      routeType: 'domestic',
      destinationCountry: 'NG',
      now,
      fetchFiatRate: usdcRate,
    }),
    { message: 'This payment exceeds your tier 1 single transaction limit.' },
  );
});

test('incomplete daily history fails closed instead of undercounting', async () => {
  resetPrisma();
  prismaMock.kycProfile.findUnique = async () => approvedProfile();
  prismaMock.transaction.findMany = async () => [{
    amount: '10.0000000',
    asset: 'USDC',
    fiatAmount: null,
    fiatCurrency: null,
  }];

  await assert.rejects(
    () => enforceTransactionPolicy({
      user,
      amount: '1.0000000',
      asset: 'USDC',
      routeType: 'domestic',
      destinationCountry: 'NG',
      now,
      fetchFiatRate: usdcRate,
    }),
    (error) => {
      assert.equal(error.code, POLICY_ERROR_CODES.DAILY_TOTAL_INCOMPLETE);
      return true;
    },
  );
});

test('stale and unavailable FX fail closed before a send is approved', async () => {
  resetPrisma();
  prismaMock.kycProfile.findUnique = async () => approvedProfile();

  await assert.rejects(
    () => enforceTransactionPolicy({
      user,
      amount: '1.0000000',
      asset: 'USDC',
      routeType: 'domestic',
      destinationCountry: 'NG',
      now,
      fetchFiatRate: async () => ({ rate: '1550.00', fetchedAt: new Date(now.getTime() - 300001) }),
    }),
    (error) => {
      assert.equal(error.code, POLICY_ERROR_CODES.FX_STALE);
      return true;
    },
  );

  await assert.rejects(
    () => enforceTransactionPolicy({
      user,
      amount: '1.0000000',
      asset: 'USDC',
      routeType: 'domestic',
      destinationCountry: 'NG',
      now,
      fetchFiatRate: async () => null,
    }),
    (error) => {
      assert.equal(error.code, POLICY_ERROR_CODES.FX_UNAVAILABLE);
      return true;
    },
  );
});
