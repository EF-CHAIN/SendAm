'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const prisma = require('../src/common/prisma');
const kycDecisionService = require('../src/compliance/kycDecision.service');

const {
  KYC_STATUSES,
  SANCTIONS_STATUSES,
  CUSTODY_STATUSES,
  RISK_THRESHOLDS,
  classifyRiskScore,
  evaluateKycDecision,
  getActivityLimits,
  syncKycAndRiskState,
  enforceWalletActivityLimit,
} = kycDecisionService;

describe('kycDecision.service', () => {
  beforeEach(() => {
    prisma.kycProfile = {};
    prisma.user = {};
    prisma.transaction = {};
    prisma.auditLog = {
      findFirst: async () => null,
      create: async () => ({ id: 'audit-1' }),
    };
    prisma.event = {
      create: async () => ({ id: 'event-1' }),
    };
  });

  describe('classifyRiskScore', () => {
    it('classifies risk score correctly across all bands', () => {
      assert.equal(classifyRiskScore(0), 'low');
      assert.equal(classifyRiskScore(RISK_THRESHOLDS.LOW_MAX), 'low');
      assert.equal(classifyRiskScore(RISK_THRESHOLDS.LOW_MAX + 1), 'medium');
      assert.equal(classifyRiskScore(RISK_THRESHOLDS.MEDIUM_MAX), 'medium');
      assert.equal(classifyRiskScore(RISK_THRESHOLDS.MEDIUM_MAX + 1), 'high');
      assert.equal(classifyRiskScore(RISK_THRESHOLDS.HIGH_MAX), 'high');
      assert.equal(classifyRiskScore(RISK_THRESHOLDS.CRITICAL_MIN), 'critical');
      assert.equal(classifyRiskScore(100), 'critical');
      assert.equal(classifyRiskScore(150), 'critical'); // clamps to 100
      assert.equal(classifyRiskScore(-20), 'low'); // clamps to 0
      assert.equal(classifyRiskScore(null), 'low');
    });
  });

  describe('evaluateKycDecision', () => {
    it('handles manual review status when provided', () => {
      const resApproved = evaluateKycDecision({
        profile: { tier: 0 },
        manualReviewStatus: { status: KYC_STATUSES.APPROVED, tier: 2, reason: 'Verified by admin' },
      });
      assert.deepEqual(resApproved, {
        status: KYC_STATUSES.APPROVED,
        tier: 2,
        reason: 'Verified by admin',
        escalated: false,
      });

      const resEscalated = evaluateKycDecision({
        profile: { tier: 1 },
        manualReviewStatus: { status: KYC_STATUSES.ESCALATED },
      });
      assert.deepEqual(resEscalated, {
        status: KYC_STATUSES.ESCALATED,
        tier: 1,
        reason: null,
        escalated: true,
      });

      const resReview = evaluateKycDecision({
        profile: { tier: 1 },
        manualReviewStatus: { status: KYC_STATUSES.REVIEW },
      });
      assert.equal(resReview.escalated, true);
    });

    it('approves verification for provider result codes 1020 and 1021', () => {
      const res1020 = evaluateKycDecision({ profile: { tier: 0 }, providerResultCode: '1020' });
      assert.deepEqual(res1020, {
        status: KYC_STATUSES.APPROVED,
        tier: 1,
        reason: null,
        escalated: false,
      });

      const res1021 = evaluateKycDecision({ profile: { tier: 0 }, providerResultCode: 1021 });
      assert.deepEqual(res1021, {
        status: KYC_STATUSES.APPROVED,
        tier: 1,
        reason: null,
        escalated: false,
      });
    });

    it('rejects verification for provider result code 1022', () => {
      const res1022 = evaluateKycDecision({ profile: { tier: 1 }, providerResultCode: '1022' });
      assert.deepEqual(res1022, {
        status: KYC_STATUSES.REJECTED,
        tier: 0,
        reason: 'Identity details did not match official government registry records.',
        escalated: false,
      });
    });

    it('routes unknown or error codes to manual compliance review and escalates', () => {
      const resOther = evaluateKycDecision({ profile: { tier: 0 }, providerResultCode: '5000' });
      assert.deepEqual(resOther, {
        status: KYC_STATUSES.REVIEW,
        tier: 0,
        reason: 'Provider result requires compliance operator manual review.',
        escalated: true,
      });

      const resEmpty = evaluateKycDecision({ profile: { tier: 0 } });
      assert.equal(resEmpty.status, KYC_STATUSES.REVIEW);
      assert.equal(resEmpty.escalated, true);
    });
  });

  describe('getActivityLimits', () => {
    it('returns zero limits for critical risk score', () => {
      const limits = getActivityLimits(2, 90, 'trusted');
      assert.equal(limits.riskClass, 'critical');
      assert.equal(limits.send.single, '0.00');
      assert.equal(limits.send.daily, '0.00');
      assert.equal(limits.receive.single, '0.00');
      assert.equal(limits.withdraw.single, '0.00');
    });

    it('returns full base limits for tier 1 with low risk and trusted session', () => {
      const limits = getActivityLimits(1, 10, 'trusted');
      assert.equal(limits.riskClass, 'low');
      assert.equal(limits.send.single, '20000.00');
      assert.equal(limits.send.daily, '50000.00');
      assert.equal(limits.send.monthly, '500000.00');
    });

    it('halves limits for high risk profile', () => {
      const limits = getActivityLimits(1, 70, 'trusted');
      assert.equal(limits.riskClass, 'high');
      assert.equal(limits.send.single, '10000.00');
      assert.equal(limits.send.daily, '25000.00');
      assert.equal(limits.send.monthly, '250000.00');
    });

    it('halves limits for untrusted session even with low risk', () => {
      const limits = getActivityLimits(1, 10, 'untrusted');
      assert.equal(limits.sessionTrust, 'untrusted');
      assert.equal(limits.send.single, '10000.00');
      assert.equal(limits.send.daily, '25000.00');
    });

    it('falls back to tier 0 limits for unknown tier', () => {
      const limits = getActivityLimits(99, 10, 'trusted');
      assert.equal(limits.send.single, '0.00');
    });
  });

  describe('syncKycAndRiskState', () => {
    it('updates KycProfile and User and writes audit log + event', async () => {
      let profileUpdatedWith = null;
      let userUpdatedWith = null;

      prisma.kycProfile.update = async (params) => {
        profileUpdatedWith = params;
        return {
          id: 'profile-1',
          userId: params.where.userId,
          tier: params.data.tier,
          status: params.data.status,
          riskScore: params.data.riskScore,
          sanctionsStatus: params.data.sanctionsStatus,
          custodyStatus: params.data.custodyStatus,
        };
      };

      prisma.user.update = async (params) => {
        userUpdatedWith = params;
        return { id: params.where.id };
      };

      const result = await syncKycAndRiskState({
        userId: 'user-123',
        tier: 2,
        status: KYC_STATUSES.APPROVED,
        riskScore: 25,
        sanctionsStatus: SANCTIONS_STATUSES.CLEARED,
        custodyStatus: CUSTODY_STATUSES.APPROVED,
        deniedReason: null,
        metadata: { source: 'unit-test' },
      });

      assert.equal(result.userId, 'user-123');
      assert.equal(result.tier, 2);
      assert.equal(profileUpdatedWith.data.tier, 2);
      assert.equal(profileUpdatedWith.data.status, KYC_STATUSES.APPROVED);
      assert.equal(userUpdatedWith.data.kycTier, 2);
      assert.equal(userUpdatedWith.data.riskScore, 25);
    });

    it('clamps riskScore between 0 and 100 on sync', async () => {
      let savedRiskScore = null;
      prisma.kycProfile.update = async (params) => {
        savedRiskScore = params.data.riskScore;
        return { id: 'prof-1', ...params.data };
      };
      prisma.user.update = async () => ({ id: 'user-1' });

      await syncKycAndRiskState({ userId: 'user-1', riskScore: 150 });
      assert.equal(savedRiskScore, 100);

      await syncKycAndRiskState({ userId: 'user-1', riskScore: -10 });
      assert.equal(savedRiskScore, 0);
    });
  });

  describe('enforceWalletActivityLimit', () => {
    it('throws 403 ACCOUNT_DEACTIVATED if user is deactivated', async () => {
      await assert.rejects(
        async () => {
          await enforceWalletActivityLimit({
            user: { id: 'user-1', deactivatedAt: new Date() },
            amount: '1000.00',
            asset: 'NGN',
          });
        },
        (err) => err.statusCode === 403 && err.code === 'ACCOUNT_DEACTIVATED',
      );
    });

    it('throws 403 KYC_NOT_FOUND when KYC profile does not exist', async () => {
      prisma.kycProfile.findUnique = async () => null;
      await assert.rejects(
        async () => {
          await enforceWalletActivityLimit({
            user: { id: 'user-1' },
            amount: '1000.00',
            asset: 'NGN',
          });
        },
        (err) => err.statusCode === 403 && err.code === 'KYC_NOT_FOUND',
      );
    });

    it('throws 403 CRITICAL_RISK_BLOCK if user has critical risk score', async () => {
      await assert.rejects(
        async () => {
          await enforceWalletActivityLimit({
            user: { id: 'user-1' },
            profile: { tier: 2, riskScore: 85, status: KYC_STATUSES.APPROVED },
            amount: '1000.00',
            asset: 'NGN',
          });
        },
        (err) => err.statusCode === 403 && err.code === 'CRITICAL_RISK_BLOCK',
      );
    });

    it('throws 403 KYC_REQUIRED for send/withdraw when KYC is not approved', async () => {
      await assert.rejects(
        async () => {
          await enforceWalletActivityLimit({
            user: { id: 'user-1' },
            profile: { tier: 0, riskScore: 10, status: KYC_STATUSES.PENDING },
            operation: 'send',
            amount: '1000.00',
            asset: 'NGN',
          });
        },
        (err) => err.statusCode === 403 && err.code === 'KYC_REQUIRED',
      );
    });

    it('throws 403 SANCTIONS_BLOCKED when sanctionsStatus is blocked', async () => {
      await assert.rejects(
        async () => {
          await enforceWalletActivityLimit({
            user: { id: 'user-1' },
            profile: {
              tier: 1,
              riskScore: 10,
              status: KYC_STATUSES.APPROVED,
              sanctionsStatus: SANCTIONS_STATUSES.BLOCKED,
            },
            operation: 'send',
            amount: '1000.00',
            asset: 'NGN',
          });
        },
        (err) => err.statusCode === 403 && err.code === 'SANCTIONS_BLOCKED',
      );
    });

    it('throws 403 SANCTIONS_REVIEW when sanctionsStatus is review', async () => {
      await assert.rejects(
        async () => {
          await enforceWalletActivityLimit({
            user: { id: 'user-1' },
            profile: {
              tier: 1,
              riskScore: 10,
              status: KYC_STATUSES.APPROVED,
              sanctionsStatus: SANCTIONS_STATUSES.REVIEW,
            },
            operation: 'withdraw',
            amount: '1000.00',
            asset: 'NGN',
          });
        },
        (err) => err.statusCode === 403 && err.code === 'SANCTIONS_REVIEW',
      );
    });

    it('throws 403 CUSTODY_DENIED when custodyStatus is denied', async () => {
      await assert.rejects(
        async () => {
          await enforceWalletActivityLimit({
            user: { id: 'user-1' },
            profile: {
              tier: 1,
              riskScore: 10,
              status: KYC_STATUSES.APPROVED,
              custodyStatus: CUSTODY_STATUSES.DENIED,
            },
            operation: 'withdraw',
            amount: '1000.00',
            asset: 'NGN',
          });
        },
        (err) => err.statusCode === 403 && err.code === 'CUSTODY_DENIED',
      );
    });

    it('throws 400 SINGLE_LIMIT_EXCEEDED when transaction exceeds single limit', async () => {
      await assert.rejects(
        async () => {
          await enforceWalletActivityLimit({
            user: { id: 'user-1' },
            profile: { tier: 1, riskScore: 10, status: KYC_STATUSES.APPROVED },
            operation: 'send',
            amount: '25000.00', // tier 1 single send limit is 20000.00
            asset: 'NGN',
          });
        },
        (err) => err.statusCode === 400 && err.code === 'SINGLE_LIMIT_EXCEEDED',
      );
    });

    it('throws 400 DAILY_LIMIT_EXCEEDED when transaction exceeds rolling daily limit', async () => {
      prisma.transaction.findMany = async () => [
        { amount: '40000.00', asset: 'NGN', fiatAmount: '40000.00', fiatCurrency: 'NGN' },
      ];

      await assert.rejects(
        async () => {
          await enforceWalletActivityLimit({
            user: { id: 'user-1' },
            profile: { tier: 1, riskScore: 10, status: KYC_STATUSES.APPROVED },
            operation: 'send',
            amount: '15000.00', // 40000 + 15000 = 55000 > 50000 limit
            asset: 'NGN',
          });
        },
        (err) => err.statusCode === 400 && err.code === 'DAILY_LIMIT_EXCEEDED',
      );
    });

    it('allows valid transfer within limits and returns evaluated payload', async () => {
      prisma.transaction.findMany = async () => [
        { amount: '5000.00', asset: 'NGN', fiatAmount: '5000.00', fiatCurrency: 'NGN' },
      ];

      const result = await enforceWalletActivityLimit({
        user: { id: 'user-1' },
        profile: { tier: 1, riskScore: 10, status: KYC_STATUSES.APPROVED },
        operation: 'send',
        amount: '10000.00',
        asset: 'NGN',
      });

      assert.equal(result.allowed, true);
      assert.equal(result.tier, 1);
      assert.equal(result.riskClass, 'low');
      assert.ok(result.limits);
      assert.ok(result.policySnapshot);
    });
  });
});
