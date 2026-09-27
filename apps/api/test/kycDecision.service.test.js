const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const injectMock = (relativeFromSrc, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

// ── Mock states & dependencies ──────────────────────────────────────────────
let auditLogs = [];
let events = [];
let dbUsers = new Map();
let dbProfiles = new Map();
let dbTransactions = [];

const mockPrisma = {
  kycProfile: {
    findUnique: async ({ where }) => {
      if (where.userId) return dbProfiles.get(where.userId) || null;
      if (where.id) {
        for (const p of dbProfiles.values()) {
          if (p.id === where.id) return p;
        }
      }
      return null;
    },
    update: async ({ where, data }) => {
      const existing = dbProfiles.get(where.userId) || { id: 'prof_default', userId: where.userId };
      const updated = { ...existing, ...data };
      dbProfiles.set(where.userId, updated);
      return updated;
    },
  },
  user: {
    update: async ({ where, data }) => {
      const existing = dbUsers.get(where.id) || { id: where.id };
      const updated = { ...existing, ...data };
      dbUsers.set(where.id, updated);
      return updated;
    },
  },
  transaction: {
    findMany: async ({ where }) => {
      return dbTransactions.filter((tx) => {
        if (tx.userId !== where.userId) return false;
        if (where.type && tx.type !== where.type) return false;
        if (where.status?.in && !where.status.in.includes(tx.status)) return false;
        if (where.createdAt?.gte && new Date(tx.createdAt) < new Date(where.createdAt.gte)) return false;
        return true;
      });
    },
  },
};

const mockAuditService = {
  writeAuditLog: async (log) => {
    auditLogs.push(log);
    return log;
  },
};

const mockEventService = {
  EVENT_TYPES: {
    KYC_EVALUATED: 'kyc.evaluated',
  },
  appendEvent: async (evt) => {
    events.push(evt);
    return evt;
  },
};

const mockConfig = {
  compliance: {
    policyCurrency: 'NGN',
    policyVersion: '1',
    policyFxMaxAgeMs: 300000,
    tierLimits: {
      0: {
        send: { single: '0.00', daily: '0.00', monthly: '0.00' },
        receive: { single: '0.00', daily: '0.00' },
        withdraw: { single: '0.00', daily: '0.00' },
      },
      1: {
        send: { single: '20000.00', daily: '50000.00', monthly: '500000.00' },
        receive: { single: '50000.00', daily: '100000.00' },
        withdraw: { single: '20000.00', daily: '50000.00' },
      },
      2: {
        send: { single: '200000.00', daily: '500000.00', monthly: '5000000.00' },
        receive: { single: '500000.00', daily: '1000000.00' },
        withdraw: { single: '200000.00', daily: '500000.00' },
      },
      3: {
        send: { single: '1000000.00', daily: '5000000.00', monthly: '50000000.00' },
        receive: { single: '5000000.00', daily: '10000000.00' },
        withdraw: { single: '1000000.00', daily: '5000000.00' },
      },
    },
  },
  pricing: {
    exchangeRateApiKey: 'test-key',
  },
};

injectMock('common/prisma', mockPrisma);
injectMock('common/audit.service', mockAuditService);
injectMock('common/event.service', mockEventService);
injectMock('config/env', mockConfig);

// Require the target module directly
const {
  KYC_STATUSES,
  SANCTIONS_STATUSES,
  CUSTODY_STATUSES,
  RISK_THRESHOLDS,
  DEFAULT_ACTIVITY_LIMITS,
  getPolicyCurrency,
  classifyRiskScore,
  evaluateKycDecision,
  getActivityLimits,
  syncKycAndRiskState,
  enforceWalletActivityLimit,
} = require('../src/compliance/kycDecision.service');

describe('kycDecision.service.js unit tests', () => {
  beforeEach(() => {
    auditLogs = [];
    events = [];
    dbUsers.clear();
    dbProfiles.clear();
    dbTransactions = [];
  });

  describe('Constants & Currency Helpers', () => {
    test('exports standardized lifecycle status objects with frozen keys', () => {
      assert.equal(KYC_STATUSES.NOT_STARTED, 'not_started');
      assert.equal(KYC_STATUSES.PENDING, 'pending');
      assert.equal(KYC_STATUSES.REVIEW, 'review');
      assert.equal(KYC_STATUSES.APPROVED, 'approved');
      assert.equal(KYC_STATUSES.REJECTED, 'rejected');
      assert.equal(KYC_STATUSES.ESCALATED, 'escalated');

      assert.equal(SANCTIONS_STATUSES.NOT_SCREENED, 'not_screened');
      assert.equal(SANCTIONS_STATUSES.CLEARED, 'cleared');
      assert.equal(SANCTIONS_STATUSES.REVIEW, 'review');
      assert.equal(SANCTIONS_STATUSES.BLOCKED, 'blocked');

      assert.equal(CUSTODY_STATUSES.NOT_REVIEWED, 'not_reviewed');
      assert.equal(CUSTODY_STATUSES.APPROVED, 'approved');
      assert.equal(CUSTODY_STATUSES.REVIEW, 'review');
      assert.equal(CUSTODY_STATUSES.DENIED, 'denied');
    });

    test('exports risk thresholds and default activity limits', () => {
      assert.equal(RISK_THRESHOLDS.LOW_MAX, 29);
      assert.equal(RISK_THRESHOLDS.MEDIUM_MAX, 59);
      assert.equal(RISK_THRESHOLDS.HIGH_MAX, 79);
      assert.equal(RISK_THRESHOLDS.CRITICAL_MIN, 80);

      assert.ok(DEFAULT_ACTIVITY_LIMITS[0]);
      assert.ok(DEFAULT_ACTIVITY_LIMITS[1]);
      assert.ok(DEFAULT_ACTIVITY_LIMITS[2]);
      assert.ok(DEFAULT_ACTIVITY_LIMITS[3]);
    });

    test('getPolicyCurrency returns configured currency or default NGN', () => {
      assert.equal(getPolicyCurrency(), 'NGN');
    });
  });

  describe('classifyRiskScore', () => {
    test('classifies risk scores into correct risk bands', () => {
      // low: 0 - 29
      assert.equal(classifyRiskScore(0), 'low');
      assert.equal(classifyRiskScore(15), 'low');
      assert.equal(classifyRiskScore(29), 'low');

      // medium: 30 - 59
      assert.equal(classifyRiskScore(30), 'medium');
      assert.equal(classifyRiskScore(45), 'medium');
      assert.equal(classifyRiskScore(59), 'medium');

      // high: 60 - 79
      assert.equal(classifyRiskScore(60), 'high');
      assert.equal(classifyRiskScore(70), 'high');
      assert.equal(classifyRiskScore(79), 'high');

      // critical: 80 - 100
      assert.equal(classifyRiskScore(80), 'critical');
      assert.equal(classifyRiskScore(95), 'critical');
      assert.equal(classifyRiskScore(100), 'critical');
    });

    test('handles edge case inputs (negative, out of bounds, invalid values)', () => {
      assert.equal(classifyRiskScore(-10), 'low');
      assert.equal(classifyRiskScore(150), 'critical');
      assert.equal(classifyRiskScore(null), 'low');
      assert.equal(classifyRiskScore(undefined), 'low');
      assert.equal(classifyRiskScore('invalid_str'), 'low');
      assert.equal(classifyRiskScore('85'), 'critical');
    });
  });

  describe('evaluateKycDecision', () => {
    test('handles manualReviewStatus override when provided', () => {
      const decision1 = evaluateKycDecision({
        profile: { tier: 1 },
        manualReviewStatus: { status: KYC_STATUSES.APPROVED, tier: 2, reason: 'Manual override by senior officer' },
      });
      assert.deepEqual(decision1, {
        status: KYC_STATUSES.APPROVED,
        tier: 2,
        reason: 'Manual override by senior officer',
        escalated: false,
      });

      const decision2 = evaluateKycDecision({
        profile: { tier: 0 },
        manualReviewStatus: { status: KYC_STATUSES.ESCALATED, reason: 'Suspicious doc' },
      });
      assert.deepEqual(decision2, {
        status: KYC_STATUSES.ESCALATED,
        tier: 0,
        reason: 'Suspicious doc',
        escalated: true,
      });

      const decision3 = evaluateKycDecision({
        profile: { tier: 0 },
        manualReviewStatus: { status: KYC_STATUSES.REVIEW },
      });
      assert.deepEqual(decision3, {
        status: KYC_STATUSES.REVIEW,
        tier: 0,
        reason: null,
        escalated: true,
      });
    });

    test('evaluates provider resultCode 1020 & 1021 as approved tier 1', () => {
      const res1020 = evaluateKycDecision({ profile: {}, providerResultCode: '1020' });
      assert.deepEqual(res1020, {
        status: KYC_STATUSES.APPROVED,
        tier: 1,
        reason: null,
        escalated: false,
      });

      const res1021 = evaluateKycDecision({ profile: {}, providerResultCode: 1021 });
      assert.deepEqual(res1021, {
        status: KYC_STATUSES.APPROVED,
        tier: 1,
        reason: null,
        escalated: false,
      });
    });

    test('evaluates provider resultCode 1022 as rejected tier 0 with explanation', () => {
      const res1022 = evaluateKycDecision({ profile: {}, providerResultCode: '1022' });
      assert.deepEqual(res1022, {
        status: KYC_STATUSES.REJECTED,
        tier: 0,
        reason: 'Identity details did not match official government registry records.',
        escalated: false,
      });
    });

    test('evaluates unknown providerResultCode or missing code as review tier 0 (escalated)', () => {
      const resUnknown = evaluateKycDecision({ profile: {}, providerResultCode: '9999' });
      assert.deepEqual(resUnknown, {
        status: KYC_STATUSES.REVIEW,
        tier: 0,
        reason: 'Provider result requires compliance operator manual review.',
        escalated: true,
      });

      const resNull = evaluateKycDecision({ profile: {} });
      assert.deepEqual(resNull, {
        status: KYC_STATUSES.REVIEW,
        tier: 0,
        reason: 'Provider result requires compliance operator manual review.',
        escalated: true,
      });
    });
  });

  describe('getActivityLimits', () => {
    test('returns full activity limits for standard low/medium risk and trusted session', () => {
      const limitsTier1 = getActivityLimits(1, 10, 'trusted');
      assert.equal(limitsTier1.tier, 1);
      assert.equal(limitsTier1.riskClass, 'low');
      assert.equal(limitsTier1.sessionTrust, 'trusted');
      assert.equal(limitsTier1.send.single, '20000.00');
      assert.equal(limitsTier1.send.daily, '50000.00');
      assert.equal(limitsTier1.send.monthly, '500000.00');
      assert.equal(limitsTier1.receive.single, '50000.00');
      assert.equal(limitsTier1.receive.daily, '100000.00');
      assert.equal(limitsTier1.withdraw.single, '20000.00');
      assert.equal(limitsTier1.withdraw.daily, '50000.00');
    });

    test('halves limits for high risk user (score 60-79)', () => {
      const limitsHigh = getActivityLimits(1, 70, 'trusted');
      assert.equal(limitsHigh.riskClass, 'high');
      assert.equal(limitsHigh.send.single, '10000.00');
      assert.equal(limitsHigh.send.daily, '25000.00');
      assert.equal(limitsHigh.send.monthly, '250000.00');
      assert.equal(limitsHigh.receive.single, '25000.00');
      assert.equal(limitsHigh.receive.daily, '50000.00');
      assert.equal(limitsHigh.withdraw.single, '10000.00');
      assert.equal(limitsHigh.withdraw.daily, '25000.00');
    });

    test('halves limits for untrusted session even if low risk', () => {
      const limitsUntrusted = getActivityLimits(1, 10, 'untrusted');
      assert.equal(limitsUntrusted.sessionTrust, 'untrusted');
      assert.equal(limitsUntrusted.send.single, '10000.00');
      assert.equal(limitsUntrusted.send.daily, '25000.00');
    });

    test('returns zeroed limits for critical risk user (score >= 80)', () => {
      const limitsCritical = getActivityLimits(2, 85, 'trusted');
      assert.equal(limitsCritical.riskClass, 'critical');
      assert.equal(limitsCritical.send.single, '0.00');
      assert.equal(limitsCritical.send.daily, '0.00');
      assert.equal(limitsCritical.send.monthly, '0.00');
      assert.equal(limitsCritical.receive.single, '0.00');
      assert.equal(limitsCritical.receive.daily, '0.00');
      assert.equal(limitsCritical.withdraw.single, '0.00');
      assert.equal(limitsCritical.withdraw.daily, '0.00');
    });

    test('handles default tier 0 when invalid tier requested', () => {
      const limitsTier0 = getActivityLimits(99, 0, 'trusted');
      assert.equal(limitsTier0.send.single, '0.00');
      assert.equal(limitsTier0.send.daily, '0.00');
    });
  });

  describe('syncKycAndRiskState', () => {
    test('updates profile, user, writes audit log, and appends event', async () => {
      const userId = 'user_sync_1';
      dbProfiles.set(userId, { id: 'prof_1', userId, tier: 0, status: 'pending', riskScore: 0 });
      dbUsers.set(userId, { id: userId, kycTier: 0, riskScore: 0 });

      const updated = await syncKycAndRiskState({
        userId,
        tier: 1,
        status: KYC_STATUSES.APPROVED,
        riskScore: 25,
        sanctionsStatus: SANCTIONS_STATUSES.CLEARED,
        custodyStatus: CUSTODY_STATUSES.APPROVED,
        metadata: { provider: 'smileid', verifiedBy: 'automated' },
        actorType: 'system',
        actorId: 'test_runner',
      });

      assert.equal(updated.tier, 1);
      assert.equal(updated.status, KYC_STATUSES.APPROVED);
      assert.equal(updated.riskScore, 25);
      assert.equal(updated.sanctionsStatus, SANCTIONS_STATUSES.CLEARED);
      assert.equal(updated.custodyStatus, CUSTODY_STATUSES.APPROVED);

      // Verify User table was also updated
      const user = dbUsers.get(userId);
      assert.equal(user.kycTier, 1);
      assert.equal(user.riskScore, 25);

      // Verify audit log
      assert.equal(auditLogs.length, 1);
      assert.equal(auditLogs[0].action, 'compliance.kyc_risk.synchronized');
      assert.equal(auditLogs[0].metadata.userId, userId);
      assert.equal(auditLogs[0].metadata.riskClass, 'low');

      // Verify event
      assert.equal(events.length, 1);
      assert.equal(events[0].eventType, 'kyc.evaluated');
      assert.equal(events[0].payload.userId, userId);
    });

    test('clamps risk score between 0 and 100 on sync', async () => {
      const userId = 'user_sync_2';
      dbProfiles.set(userId, { id: 'prof_2', userId });
      dbUsers.set(userId, { id: userId });

      await syncKycAndRiskState({
        userId,
        riskScore: 150,
        deniedReason: 'Excess risk',
      });

      const prof = dbProfiles.get(userId);
      assert.equal(prof.riskScore, 100);
      assert.equal(prof.deniedReason, 'Excess risk');

      const user = dbUsers.get(userId);
      assert.equal(user.riskScore, 100);
    });
  });

  describe('enforceWalletActivityLimit', () => {
    const user = { id: 'user_active_1', deactivatedAt: null };
    const approvedTier1Profile = {
      id: 'prof_1',
      userId: 'user_active_1',
      tier: 1,
      status: KYC_STATUSES.APPROVED,
      riskScore: 10,
      sanctionsStatus: SANCTIONS_STATUSES.CLEARED,
      custodyStatus: CUSTODY_STATUSES.APPROVED,
    };

    beforeEach(() => {
      dbProfiles.set(user.id, approvedTier1Profile);
      dbUsers.set(user.id, user);
    });

    test('successfully allows valid send within single and daily limits', async () => {
      const result = await enforceWalletActivityLimit({
        user,
        profile: approvedTier1Profile,
        operation: 'send',
        amount: '5000.00',
        asset: 'NGN',
      });

      assert.equal(result.allowed, true);
      assert.equal(result.tier, 1);
      assert.equal(result.riskClass, 'low');
      assert.equal(result.limits.single, '20000.00');

      const evalLog = auditLogs.find((l) => l.action === 'compliance.limit.evaluated');
      assert.ok(evalLog);
      assert.equal(evalLog.metadata.operation, 'send');
    });

    test('throws 403 ACCOUNT_DEACTIVATED if user is deactivated', async () => {
      await assert.rejects(
        () =>
          enforceWalletActivityLimit({
            user: { ...user, deactivatedAt: new Date() },
            operation: 'send',
            amount: '100.00',
          }),
        {
          statusCode: 403,
          code: 'ACCOUNT_DEACTIVATED',
        },
      );
    });

    test('throws 403 KYC_NOT_FOUND if profile is missing', async () => {
      dbProfiles.delete(user.id);
      await assert.rejects(
        () =>
          enforceWalletActivityLimit({
            user,
            profile: null,
            operation: 'send',
            amount: '100.00',
          }),
        {
          statusCode: 403,
          code: 'KYC_NOT_FOUND',
        },
      );
    });

    test('throws 403 CRITICAL_RISK_BLOCK if user risk score is >= 80', async () => {
      const criticalProfile = { ...approvedTier1Profile, riskScore: 85 };
      await assert.rejects(
        () =>
          enforceWalletActivityLimit({
            user,
            profile: criticalProfile,
            operation: 'send',
            amount: '100.00',
          }),
        {
          statusCode: 403,
          code: 'CRITICAL_RISK_BLOCK',
        },
      );

      const rejectLog = auditLogs.find((l) => l.action === 'compliance.limit.rejected');
      assert.ok(rejectLog);
      assert.equal(rejectLog.metadata.reason, 'CRITICAL_RISK_BLOCK');
    });

    test('throws 403 KYC_REQUIRED if status is not approved when sending or withdrawing', async () => {
      const pendingProfile = { ...approvedTier1Profile, status: KYC_STATUSES.PENDING };
      await assert.rejects(
        () =>
          enforceWalletActivityLimit({
            user,
            profile: pendingProfile,
            operation: 'send',
            amount: '100.00',
          }),
        {
          statusCode: 403,
          code: 'KYC_REQUIRED',
        },
      );
    });

    test('throws 403 SANCTIONS_BLOCKED if sanctions status is blocked', async () => {
      const blockedProfile = { ...approvedTier1Profile, sanctionsStatus: SANCTIONS_STATUSES.BLOCKED };
      await assert.rejects(
        () =>
          enforceWalletActivityLimit({
            user,
            profile: blockedProfile,
            operation: 'send',
            amount: '100.00',
          }),
        {
          statusCode: 403,
          code: 'SANCTIONS_BLOCKED',
        },
      );
    });

    test('throws 403 SANCTIONS_REVIEW if sanctions status is review', async () => {
      const reviewProfile = { ...approvedTier1Profile, sanctionsStatus: SANCTIONS_STATUSES.REVIEW };
      await assert.rejects(
        () =>
          enforceWalletActivityLimit({
            user,
            profile: reviewProfile,
            operation: 'withdraw',
            amount: '100.00',
          }),
        {
          statusCode: 403,
          code: 'SANCTIONS_REVIEW',
        },
      );
    });

    test('throws 403 CUSTODY_DENIED if custody status is denied', async () => {
      const deniedProfile = { ...approvedTier1Profile, custodyStatus: CUSTODY_STATUSES.DENIED };
      await assert.rejects(
        () =>
          enforceWalletActivityLimit({
            user,
            profile: deniedProfile,
            operation: 'send',
            amount: '100.00',
          }),
        {
          statusCode: 403,
          code: 'CUSTODY_DENIED',
        },
      );
    });

    test('throws 400 SINGLE_LIMIT_EXCEEDED when transaction exceeds single allowance', async () => {
      await assert.rejects(
        () =>
          enforceWalletActivityLimit({
            user,
            profile: approvedTier1Profile,
            operation: 'send',
            amount: '25000.00', // Tier 1 single limit is 20000.00
            asset: 'NGN',
          }),
        {
          statusCode: 400,
          code: 'SINGLE_LIMIT_EXCEEDED',
        },
      );

      const rejectLog = auditLogs.find((l) => l.action === 'compliance.limit.rejected');
      assert.ok(rejectLog);
      assert.equal(rejectLog.metadata.reason, 'SINGLE_LIMIT_EXCEEDED');
    });

    test('throws 400 DAILY_LIMIT_EXCEEDED when rolling 24h total exceeds limit', async () => {
      // Tier 1 daily limit is 50000.00
      dbTransactions.push(
        {
          userId: user.id,
          type: 'send',
          status: 'success',
          amount: '15000.00',
          asset: 'NGN',
          fiatAmount: '15000.00',
          fiatCurrency: 'NGN',
          createdAt: new Date(),
        },
        {
          userId: user.id,
          type: 'send',
          status: 'pending',
          amount: '20000.00',
          asset: 'NGN',
          fiatAmount: '20000.00',
          fiatCurrency: 'NGN',
          createdAt: new Date(),
        },
      );

      // Attempting another 20000.00 send brings total to 55000.00 > 50000.00
      await assert.rejects(
        () =>
          enforceWalletActivityLimit({
            user,
            profile: approvedTier1Profile,
            operation: 'send',
            amount: '20000.00',
            asset: 'NGN',
          }),
        {
          statusCode: 400,
          code: 'DAILY_LIMIT_EXCEEDED',
        },
      );

      const rejectLog = auditLogs.find((l) => l.action === 'compliance.limit.rejected');
      assert.ok(rejectLog);
      assert.equal(rejectLog.metadata.reason, 'DAILY_LIMIT_EXCEEDED');
    });

    test('supports currency conversion when asset is USDC and evaluates against policy limits', async () => {
      // 10 USDC @ 1500 NGN = 15,000 NGN (<= 20,000 NGN single limit)
      const mockFetchFiatRate = async () => ({ rate: '1500', fetchedAt: new Date() });

      const result = await enforceWalletActivityLimit({
        user,
        profile: approvedTier1Profile,
        operation: 'send',
        amount: '10.0000000',
        asset: 'USDC',
        fetchFiatRate: mockFetchFiatRate,
      });

      assert.equal(result.allowed, true);
      assert.equal(result.policySnapshot.convertedAmount, '15000.00');
    });

    test('ignores non-policy fiat currency in rolling daily accumulation', async () => {
      dbTransactions.push({
        userId: user.id,
        type: 'send',
        status: 'success',
        amount: '100.00',
        asset: 'USD',
        fiatAmount: '100.00',
        fiatCurrency: 'USD', // not NGN
        createdAt: new Date(),
      });

      const result = await enforceWalletActivityLimit({
        user,
        profile: approvedTier1Profile,
        operation: 'send',
        amount: '18000.00',
        asset: 'NGN',
      });

      assert.equal(result.allowed, true);
    });
  });
});
