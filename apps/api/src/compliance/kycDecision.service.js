'use strict';

/**
 * Standardized KYC Decisioning and Risk-Score Lifecycle Service (#307 & #309)
 * ─────────────────────────────────────────────────────────────────────────────
 * Centralizes KYC decisions, score thresholds, escalation rules, and activity limits
 * across all entry points (REST API, WhatsApp assistant, Admin reviews, Background workers).
 */

const config = require('../config/env');
const prisma = require('../common/prisma');
const { writeAuditLog } = require('../common/audit.service');
const { appendEvent, EVENT_TYPES } = require('../common/event.service');
const { assertValidAmount, add, compare, formatUnits, getAssetRule, parseUnits } = require('../utils/money');
const { getPolicyConversionSnapshot } = require('../pricing/policyRate');

// ── Standardized KYC Lifecycle States ──────────────────────────────────────────
const KYC_STATUSES = Object.freeze({
  NOT_STARTED: 'not_started',
  PENDING: 'pending',
  REVIEW: 'review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  ESCALATED: 'escalated',
});

// ── Standardized Sanctions & Custody States ───────────────────────────────────
const SANCTIONS_STATUSES = Object.freeze({
  NOT_SCREENED: 'not_screened',
  CLEARED: 'cleared',
  REVIEW: 'review',
  BLOCKED: 'blocked',
});

const CUSTODY_STATUSES = Object.freeze({
  NOT_REVIEWED: 'not_reviewed',
  APPROVED: 'approved',
  REVIEW: 'review',
  DENIED: 'denied',
});

// ── Risk Score Thresholds ────────────────────────────────────────────────────
const RISK_THRESHOLDS = Object.freeze({
  LOW_MAX: 29,       // 0-29: Low risk (Standard tier allowances)
  MEDIUM_MAX: 59,    // 30-59: Moderate risk (Standard tier allowances with enhanced logging)
  HIGH_MAX: 79,      // 60-79: High risk (50% reduced limits, manual review triggers on high volume)
  CRITICAL_MIN: 80,  // 80-100: Critical risk (Payments blocked, automatic compliance escalation)
});

// ── Standard Tier Limits Definition (Reference currency: NGN) ───────────────
const DEFAULT_ACTIVITY_LIMITS = {
  0: {
    send:     { single: '0.00', daily: '0.00', monthly: '0.00' },
    receive:  { single: '0.00', daily: '0.00' },
    withdraw: { single: '0.00', daily: '0.00' },
  },
  1: {
    send:     { single: '20000.00', daily: '50000.00', monthly: '500000.00' },
    receive:  { single: '50000.00', daily: '100000.00' },
    withdraw: { single: '20000.00', daily: '50000.00' },
  },
  2: {
    send:     { single: '200000.00', daily: '500000.00', monthly: '5000000.00' },
    receive:  { single: '500000.00', daily: '1000000.00' },
    withdraw: { single: '200000.00', daily: '500000.00' },
  },
  3: {
    send:     { single: '1000000.00', daily: '5000000.00', monthly: '50000000.00' },
    receive:  { single: '5000000.00', daily: '10000000.00' },
    withdraw: { single: '1000000.00', daily: '5000000.00' },
  },
};

const getPolicyCurrency = () => String(config.compliance?.policyCurrency || 'NGN').trim().toUpperCase();

const canonicalizePolicyAmount = (value, currency) => {
  const rule = getAssetRule(currency);
  return formatUnits(parseUnits(String(value), rule.precision, { rejectExcessPrecision: false }), rule.precision);
};

/**
 * Classify a numeric risk score into standardized risk bands.
 */
const classifyRiskScore = (score) => {
  const num = Math.min(Math.max(Number(score) || 0, 0), 100);
  if (num >= RISK_THRESHOLDS.CRITICAL_MIN) return 'critical';
  if (num > RISK_THRESHOLDS.MEDIUM_MAX) return 'high';
  if (num > RISK_THRESHOLDS.LOW_MAX) return 'medium';
  return 'low';
};

/**
 * Standard evaluation of KYC status and tier assignment.
 */
const evaluateKycDecision = ({ profile, providerResultCode, manualReviewStatus }) => {
  if (manualReviewStatus) {
    return {
      status: manualReviewStatus.status,
      tier: manualReviewStatus.tier !== undefined ? manualReviewStatus.tier : profile.tier,
      reason: manualReviewStatus.reason || null,
      escalated: manualReviewStatus.status === KYC_STATUSES.ESCALATED || manualReviewStatus.status === KYC_STATUSES.REVIEW,
    };
  }

  const code = String(providerResultCode || '');
  if (['1020', '1021'].includes(code)) {
    return {
      status: KYC_STATUSES.APPROVED,
      tier: 1,
      reason: null,
      escalated: false,
    };
  }

  if (code === '1022') {
    return {
      status: KYC_STATUSES.REJECTED,
      tier: 0,
      reason: 'Identity details did not match official government registry records.',
      escalated: false,
    };
  }

  return {
    status: KYC_STATUSES.REVIEW,
    tier: 0,
    reason: 'Provider result requires compliance operator manual review.',
    escalated: true,
  };
};

/**
 * Retrieve effective activity limits for a user given their verified tier and risk profile.
 */
const getActivityLimits = (tier = 0, riskScore = 0, sessionTrust = 'trusted') => {
  const currency = getPolicyCurrency();
  const baseLimits = (config.compliance?.tierLimits && config.compliance?.tierLimits[tier]) || DEFAULT_ACTIVITY_LIMITS[tier] || DEFAULT_ACTIVITY_LIMITS[0];
  const riskClass = classifyRiskScore(riskScore);

  const applyPenalty = (amountStr, multiplierStr) => {
    try {
      const precision = getAssetRule(currency).precision;
      const parsed = parseUnits(amountStr, precision);
      if (parsed === 0n) return formatUnits(0n, precision);
      // High-risk penalty halves limits; untrusted session reduces by half
      const factor = multiplierStr === 'half' ? 0.5 : 1.0;
      const reduced = Math.floor(Number(amountStr) * factor);
      return formatUnits(parseUnits(String(reduced), precision), precision);
    } catch {
      return amountStr;
    }
  };

  const isHighRisk = riskClass === 'high';
  const isCritical = riskClass === 'critical';
  const isUntrustedSession = sessionTrust === 'untrusted';

  const sendLimits = baseLimits.send || DEFAULT_ACTIVITY_LIMITS[tier]?.send || DEFAULT_ACTIVITY_LIMITS[0].send;
  const receiveLimits = baseLimits.receive || DEFAULT_ACTIVITY_LIMITS[tier]?.receive || DEFAULT_ACTIVITY_LIMITS[0].receive;
  const withdrawLimits = baseLimits.withdraw || DEFAULT_ACTIVITY_LIMITS[tier]?.withdraw || DEFAULT_ACTIVITY_LIMITS[0].withdraw;

  if (isCritical) {
    return {
      tier,
      riskClass,
      sessionTrust,
      send: { single: '0.00', daily: '0.00', monthly: '0.00' },
      receive: { single: '0.00', daily: '0.00' },
      withdraw: { single: '0.00', daily: '0.00' },
    };
  }

  const penaltyMultiplier = (isHighRisk || isUntrustedSession) ? 'half' : 'full';

  return {
    tier,
    riskClass,
    sessionTrust,
    send: {
      single: applyPenalty(canonicalizePolicyAmount(sendLimits.single, currency), penaltyMultiplier),
      daily: applyPenalty(canonicalizePolicyAmount(sendLimits.daily, currency), penaltyMultiplier),
      monthly: sendLimits.monthly ? applyPenalty(canonicalizePolicyAmount(sendLimits.monthly, currency), penaltyMultiplier) : undefined,
    },
    receive: {
      single: applyPenalty(canonicalizePolicyAmount(receiveLimits.single, currency), penaltyMultiplier),
      daily: applyPenalty(canonicalizePolicyAmount(receiveLimits.daily, currency), penaltyMultiplier),
    },
    withdraw: {
      single: applyPenalty(canonicalizePolicyAmount(withdrawLimits.single, currency), penaltyMultiplier),
      daily: applyPenalty(canonicalizePolicyAmount(withdrawLimits.daily, currency), penaltyMultiplier),
    },
  };
};

/**
 * Centralized synchronized state updater for User and KycProfile.
 */
const syncKycAndRiskState = async ({
  userId,
  tier,
  status,
  riskScore,
  sanctionsStatus,
  custodyStatus,
  deniedReason,
  metadata = {},
  actorType = 'system',
  actorId = 'compliance_engine',
  req,
  tx = prisma,
}) => {
  const dataProfile = {};
  if (tier !== undefined) dataProfile.tier = Number(tier);
  if (status !== undefined) dataProfile.status = status;
  if (riskScore !== undefined) dataProfile.riskScore = Math.min(Math.max(Number(riskScore), 0), 100);
  if (sanctionsStatus !== undefined) dataProfile.sanctionsStatus = sanctionsStatus;
  if (custodyStatus !== undefined) dataProfile.custodyStatus = custodyStatus;
  if (deniedReason !== undefined) dataProfile.deniedReason = deniedReason;
  if (metadata && Object.keys(metadata).length > 0) dataProfile.metadata = metadata;

  const dataUser = {};
  if (tier !== undefined) dataUser.kycTier = Number(tier);
  if (riskScore !== undefined) dataUser.riskScore = Math.min(Math.max(Number(riskScore), 0), 100);

  const updatedProfile = await tx.kycProfile.update({
    where: { userId },
    data: dataProfile,
  });

  if (Object.keys(dataUser).length > 0) {
    await tx.user.update({
      where: { id: userId },
      data: dataUser,
    });
  }

  await writeAuditLog({
    actorType,
    actorId,
    action: 'compliance.kyc_risk.synchronized',
    entityType: 'KycProfile',
    entityId: updatedProfile.id,
    metadata: {
      userId,
      tier: updatedProfile.tier,
      status: updatedProfile.status,
      riskScore: updatedProfile.riskScore,
      riskClass: classifyRiskScore(updatedProfile.riskScore),
      sanctionsStatus: updatedProfile.sanctionsStatus,
      custodyStatus: updatedProfile.custodyStatus,
    },
    req,
  });

  await appendEvent({
    eventType: EVENT_TYPES.KYC_EVALUATED || 'kyc.evaluated',
    aggregateType: 'KycProfile',
    aggregateId: String(updatedProfile.id),
    actorType,
    actorId,
    payload: {
      userId,
      status: updatedProfile.status,
      tier: updatedProfile.tier,
      riskScore: updatedProfile.riskScore,
    },
  }).catch(() => {});

  return updatedProfile;
};

/**
 * Enforce wallet activity limit before any financial side-effects.
 */
const enforceWalletActivityLimit = async ({
  user,
  profile,
  operation = 'send', // 'send' | 'receive' | 'withdraw'
  amount,
  asset = 'NGN',
  sessionTrust = 'trusted',
  tx = prisma,
  now = new Date(),
  fetchFiatRate,
  fetchCryptoUsdRate,
}) => {
  const referenceCurrency = getPolicyCurrency();
  const effectiveAsset = String(asset || referenceCurrency).trim().toUpperCase();
  assertValidAmount(amount, effectiveAsset);

  if (user?.deactivatedAt) {
    throw Object.assign(
      new Error('This account is deactivated. Contact support to restore access.'),
      { statusCode: 403, code: 'ACCOUNT_DEACTIVATED' },
    );
  }

  const kycProfile = profile || await tx.kycProfile.findUnique({ where: { userId: user.id } });
  if (!kycProfile) {
    throw Object.assign(
      new Error('KYC profile not found. Please complete identity verification.'),
      { statusCode: 403, code: 'KYC_NOT_FOUND' },
    );
  }

  const tier = kycProfile.tier || 0;
  const riskScore = kycProfile.riskScore || 0;
  const riskClass = classifyRiskScore(riskScore);

  if (riskClass === 'critical') {
    await writeAuditLog({
      actorType: 'user',
      actorId: String(user.id),
      action: 'compliance.limit.rejected',
      entityType: 'User',
      entityId: String(user.id),
      metadata: { operation, amount, asset: effectiveAsset, reason: 'CRITICAL_RISK_BLOCK', riskScore },
    });
    throw Object.assign(
      new Error('Account is under compliance review. Transfers are temporarily blocked.'),
      { statusCode: 403, code: 'CRITICAL_RISK_BLOCK' },
    );
  }

  if (operation === 'send' || operation === 'withdraw') {
    if (kycProfile.status !== KYC_STATUSES.APPROVED) {
      throw Object.assign(
        new Error('Identity verification (KYC) is required before moving funds.'),
        { statusCode: 403, code: 'KYC_REQUIRED' },
      );
    }
    if (kycProfile.sanctionsStatus === SANCTIONS_STATUSES.BLOCKED) {
      throw Object.assign(
        new Error('Sanctions screening permanently blocks this account from transfers.'),
        { statusCode: 403, code: 'SANCTIONS_BLOCKED' },
      );
    }
    if (kycProfile.sanctionsStatus === SANCTIONS_STATUSES.REVIEW) {
      throw Object.assign(
        new Error('This account is under sanctions compliance review and cannot transfer funds until cleared.'),
        { statusCode: 403, code: 'SANCTIONS_REVIEW' },
      );
    }
    if (kycProfile.custodyStatus === CUSTODY_STATUSES.DENIED) {
      throw Object.assign(
        new Error('Custody review denied this account from transfers.'),
        { statusCode: 403, code: 'CUSTODY_DENIED' },
      );
    }
  }

  const limits = getActivityLimits(tier, riskScore, sessionTrust);
  const opLimits = limits[operation] || limits.send;

  const policySnapshot = await getPolicyConversionSnapshot({
    sourceAsset: effectiveAsset,
    amount,
    now,
    ...(fetchFiatRate ? { fetchFiatRate } : {}),
    ...(fetchCryptoUsdRate ? { fetchCryptoUsdRate } : {}),
  });
  const convertedAmount = policySnapshot.convertedAmount;

  // 1. Single Limit Check
  if (compare(convertedAmount, opLimits.single, referenceCurrency) > 0) {
    await writeAuditLog({
      actorType: 'user',
      actorId: String(user.id),
      action: 'compliance.limit.rejected',
      entityType: 'User',
      entityId: String(user.id),
      metadata: {
        operation,
        amount,
        convertedAmount,
        limitSingle: opLimits.single,
        tier,
        riskScore,
        reason: 'SINGLE_LIMIT_EXCEEDED',
      },
    });
    throw Object.assign(
      new Error(`This ${operation} exceeds your tier ${tier} single transaction limit of ${opLimits.single} ${referenceCurrency}.`),
      { statusCode: 400, code: 'SINGLE_LIMIT_EXCEEDED' },
    );
  }

  // 2. Rolling Daily Limit Check
  const since = new Date((now instanceof Date ? now.getTime() : Date.now()) - 24 * 60 * 60 * 1000);
  const recentTransactions = await tx.transaction.findMany({
    where: {
      userId: user.id,
      type: operation === 'send' ? 'send' : operation,
      status: { in: ['success', 'processing', 'pending'] },
      createdAt: { gte: since },
    },
    select: { amount: true, asset: true, fiatAmount: true, fiatCurrency: true },
  });

  const zeroAmount = formatUnits(0n, getAssetRule(referenceCurrency).precision);
  const dailyTotal = recentTransactions.reduce((sum, t) => {
    if (!t.fiatAmount || String(t.fiatCurrency || '').trim().toUpperCase() !== referenceCurrency) {
      return sum;
    }
    return add(sum, canonicalizePolicyAmount(t.fiatAmount, referenceCurrency), referenceCurrency);
  }, zeroAmount);

  const totalWithCurrent = add(dailyTotal, convertedAmount, referenceCurrency);
  if (compare(totalWithCurrent, opLimits.daily, referenceCurrency) > 0) {
    await writeAuditLog({
      actorType: 'user',
      actorId: String(user.id),
      action: 'compliance.limit.rejected',
      entityType: 'User',
      entityId: String(user.id),
      metadata: {
        operation,
        amount,
        convertedAmount,
        dailyTotal,
        limitDaily: opLimits.daily,
        tier,
        riskScore,
        reason: 'DAILY_LIMIT_EXCEEDED',
      },
    });
    throw Object.assign(
      new Error(`This ${operation} exceeds your tier ${tier} daily limit of ${opLimits.daily} ${referenceCurrency}.`),
      { statusCode: 400, code: 'DAILY_LIMIT_EXCEEDED' },
    );
  }

  // Decision audit log
  await writeAuditLog({
    actorType: 'user',
    actorId: String(user.id),
    action: 'compliance.limit.evaluated',
    entityType: 'User',
    entityId: String(user.id),
    metadata: {
      operation,
      tier,
      riskScore,
      riskClass,
      allowedSingle: opLimits.single,
      allowedDaily: opLimits.daily,
      requestedConverted: convertedAmount,
      currency: referenceCurrency,
    },
  });

  return {
    allowed: true,
    tier,
    riskScore,
    riskClass,
    limits: opLimits,
    policySnapshot,
  };
};

module.exports = {
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
};
