const { test, beforeEach, afterEach, describe } = require('node:test');
const assert = require('node:assert/strict');

const mockPrisma = {
  user: { findUnique: async () => null },
  transaction: { findMany: async () => [] },
  ipReputationCache: { findUnique: async () => null, upsert: async () => {} },
  riskAssessment: { create: async () => {} },
};

require.cache[require.resolve('../src/common/prisma')] = { exports: mockPrisma };

const {
  calculateIPRiskScore,
  calculateCountryMismatchScore,
  calculateAccountAgeScore,
  calculateDeviceFingerprintScore,
  computeRiskScore,
  evaluateTransactionRisk,
  RISK_THRESHOLDS,
  classifyRiskScore,
} = require('../src/compliance/riskEngine');

describe('riskEngine', () => {
  beforeEach(() => {
    mockPrisma.user.findUnique = async () => ({ id: 'user-1', createdAt: new Date('2024-01-01') });
    mockPrisma.transaction.findMany = async () => [];
    mockPrisma.ipReputationCache.findUnique = async () => null;
    mockPrisma.ipReputationCache.upsert = async () => {};
    mockPrisma.riskAssessment.create = async () => {};
  });

  afterEach(() => {});

  describe('classifyRiskScore', () => {
    test('low risk 0-29', () => {
      assert.equal(classifyRiskScore(0), 'low');
      assert.equal(classifyRiskScore(29), 'low');
    });
    test('medium risk 30-59', () => {
      assert.equal(classifyRiskScore(30), 'medium');
      assert.equal(classifyRiskScore(59), 'medium');
    });
    test('high risk 60-79', () => {
      assert.equal(classifyRiskScore(60), 'high');
      assert.equal(classifyRiskScore(79), 'high');
    });
    test('critical risk 80-100', () => {
      assert.equal(classifyRiskScore(80), 'critical');
      assert.equal(classifyRiskScore(95), 'critical');
      assert.equal(classifyRiskScore(100), 'critical');
    });
  });

  describe('calculateIPRiskScore', () => {
    test('tor exit node adds 40', () => {
      const result = calculateIPRiskScore({ isTor: true, country: 'US' });
      assert.ok(result.score >= 40);
      assert.ok(result.reasons.includes('tor_exit_node'));
    });

    test('proxy/vpn/hosting adds 25', () => {
      const result = calculateIPRiskScore({ isProxy: true, country: 'US' });
      assert.ok(result.score >= 25);
      assert.ok(result.reasons.includes('proxy_vpn_hosting'));
    });

    test('high risk country adds 20', () => {
      const result = calculateIPRiskScore({ country: 'KP' });
      assert.ok(result.score >= 20);
      assert.ok(result.reasons.includes('high_risk_country'));
    });

    test('high risk ASN adds 15', () => {
      const result = calculateIPRiskScore({ asn: 'AS16276' });
      assert.ok(result.score >= 15);
      assert.ok(result.reasons.includes('high_risk_asn'));
    });

    test('clean IP has low score', () => {
      const result = calculateIPRiskScore({ country: 'US', isProxy: false, isVPN: false, isHosting: false });
      assert.equal(result.score, 0);
    });
  });

  describe('calculateCountryMismatchScore', () => {
    test('matching countries returns 0', () => {
      const result = calculateCountryMismatchScore('NG', 'NG');
      assert.equal(result.score, 0);
      assert.equal(result.reason, 'match');
    });

    test('NG phone with foreign IP adds 15', () => {
      const result = calculateCountryMismatchScore('NG', 'US');
      assert.equal(result.score, 15);
      assert.equal(result.reason, 'ng_phone_foreign_ip');
    });

    test('foreign phone with NG IP adds 10', () => {
      const result = calculateCountryMismatchScore('US', 'NG');
      assert.equal(result.score, 10);
      assert.equal(result.reason, 'foreign_phone_ng_ip');
    });

    test('other mismatch adds 12', () => {
      const result = calculateCountryMismatchScore('US', 'GB');
      assert.equal(result.score, 12);
      assert.equal(result.reason, 'country_mismatch');
    });
  });

  describe('calculateAccountAgeScore', () => {
    test('less than 1 day adds 25', () => {
      const recent = new Date(Date.now() - 12 * 60 * 60 * 1000);
      const result = calculateAccountAgeScore(recent);
      assert.equal(result.score, 25);
      assert.equal(result.reason, 'account_age_lt_1_day');
    });

    test('less than 1 week adds 15', () => {
      const recent = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const result = calculateAccountAgeScore(recent);
      assert.equal(result.score, 15);
      assert.equal(result.reason, 'account_age_lt_1_week');
    });

    test('less than 1 month adds 8', () => {
      const recent = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
      const result = calculateAccountAgeScore(recent);
      assert.equal(result.score, 8);
      assert.equal(result.reason, 'account_age_lt_1_month');
    });

    test('established account adds 0', () => {
      const old = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
      const result = calculateAccountAgeScore(old);
      assert.equal(result.score, 0);
      assert.equal(result.reason, 'established_account');
    });
  });

  describe('calculateDeviceFingerprintScore', () => {
    test('new device adds 15', () => {
      const result = calculateDeviceFingerprintScore({ isNewDevice: true }, 'user-1');
      assert.ok(result.score >= 15);
      assert.ok(result.reasons.includes('new_device'));
    });

    test('emulator adds 30', () => {
      const result = calculateDeviceFingerprintScore({ isEmulator: true }, 'user-1');
      assert.ok(result.score >= 30);
      assert.ok(result.reasons.includes('emulator_detected'));
    });

    test('rooted/jailbroken adds 25', () => {
      const result = calculateDeviceFingerprintScore({ isRooted: true }, 'user-1');
      assert.ok(result.score >= 25);
      assert.ok(result.reasons.includes('rooted_jailbroken'));
    });

    test('no device info returns 5', () => {
      const result = calculateDeviceFingerprintScore(null, 'user-1');
      assert.equal(result.score, 5);
    });
  });

  describe('computeRiskScore', () => {
    test('combines weighted factors', () => {
      const features = {
        ipRisk: { score: 50, reasons: ['tor_exit_node'] },
        countryMismatch: { score: 15, reason: 'ng_phone_foreign_ip' },
        accountAge: { score: 10, reason: 'account_age_lt_1_week' },
        velocity: { score: 20, reasons: ['high_frequency_gt_10'] },
        deviceFingerprint: { score: 30, reasons: ['new_device'] },
      };
      const result = computeRiskScore(features);
      assert.ok(result.score > 0 && result.score <= 100);
      assert.ok(['low', 'medium', 'high', 'critical'].includes(result.riskClass));
      assert.ok(result.reasons.length > 0);
    });

    test('critical score returns critical class', () => {
      const features = {
        ipRisk: { score: 100, reasons: ['tor_exit_node'] },
        countryMismatch: { score: 15, reason: 'ng_phone_foreign_ip' },
        accountAge: { score: 25, reason: 'account_age_lt_1_day' },
        velocity: { score: 40, reasons: ['high_frequency_gt_20'] },
        deviceFingerprint: { score: 50, reasons: ['emulator_detected'] },
      };
      const result = computeRiskScore(features);
      assert.equal(result.riskClass, 'critical');
    });
  });

  describe('evaluateTransactionRisk', () => {
    test('returns blocked for critical score', async () => {
      mockPrisma.user.findUnique = async () => ({ id: 'user-1', createdAt: new Date('2024-01-01'), phoneNumber: '+2348000000001' });
      mockPrisma.transaction.findMany = async () => Array(25).fill({ type: 'send', amount: '10000' });
      mockPrisma.ipReputationCache.findUnique = async () => null;
      mockPrisma.ipReputationCache.upsert = async () => ({ data: { country: 'KP', isProxy: false, isVPN: false, isHosting: false } });

      const result = await evaluateTransactionRisk({
        userId: 'user-1',
        phoneNumber: '+2348000000001',
        ip: '1.2.3.4',
        deviceInfo: { isEmulator: true },
        destinationCountry: 'US',
        amount: '100000',
        asset: 'NGN',
        routeType: 'cross_border',
      });

      assert.equal(result.action, 'blocked');
      assert.ok(result.score >= RISK_THRESHOLDS.CRITICAL_MIN);
    });

    test('returns step_up_required for high score', async () => {
      mockPrisma.user.findUnique = async () => ({ id: 'user-1', createdAt: new Date('2024-01-01'), phoneNumber: '+2348000000001' });
      mockPrisma.transaction.findMany = async () => Array(15).fill({ type: 'send', amount: '10000' });
      mockPrisma.ipReputationCache.findUnique = async () => null;
      mockPrisma.ipReputationCache.upsert = async () => ({ data: { country: 'US', isProxy: true, isVPN: false, isHosting: false } });

      const result = await evaluateTransactionRisk({
        userId: 'user-1',
        phoneNumber: '+2348000000001',
        ip: '1.2.3.4',
        deviceInfo: { isNewDevice: true },
        destinationCountry: 'US',
        amount: '50000',
        asset: 'NGN',
        routeType: 'cross_border',
      });

      assert.equal(result.action, 'step_up_required');
      assert.ok(result.score >= RISK_THRESHOLDS.HIGH_MAX);
      assert.ok(result.score < RISK_THRESHOLDS.CRITICAL_MIN);
    });

    test('returns approved for low score', async () => {
      mockPrisma.user.findUnique = async () => ({ id: 'user-1', createdAt: new Date('2022-01-01'), phoneNumber: '+2348000000001' });
      mockPrisma.transaction.findMany = async () => [{ type: 'send', amount: '1000' }];
      mockPrisma.ipReputationCache.findUnique = async () => null;
      mockPrisma.ipReputationCache.upsert = async () => ({ data: { country: 'NG', isProxy: false, isVPN: false, isHosting: false } });

      const result = await evaluateTransactionRisk({
        userId: 'user-1',
        phoneNumber: '+2348000000001',
        ip: '1.2.3.4',
        deviceInfo: {},
        destinationCountry: 'NG',
        amount: '5000',
        asset: 'NGN',
        routeType: 'domestic',
      });

      assert.equal(result.action, 'approved');
      assert.ok(result.score < RISK_THRESHOLDS.HIGH_MAX);
    });
  });
});