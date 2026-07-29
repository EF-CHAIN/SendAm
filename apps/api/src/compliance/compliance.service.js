const config = require('../config/env');
const prisma = require('../common/prisma');

const tierLimits = {
  0: { daily: 0, single: 0 },
  1: { daily: Number(process.env.TIER_1_DAILY_LIMIT || 50000), single: Number(process.env.TIER_1_SINGLE_LIMIT || 20000) },
  2: { daily: Number(process.env.TIER_2_DAILY_LIMIT || 500000), single: Number(process.env.TIER_2_SINGLE_LIMIT || 200000) },
  3: { daily: Number(process.env.TIER_3_DAILY_LIMIT || 5000000), single: Number(process.env.TIER_3_SINGLE_LIMIT || 1000000) },
};

const SANCTIONS_BLOCKED_COUNTRIES = new Set(['KP', 'IR', 'SY', 'CU', 'SD', 'SDN']);
const SANCTIONS_REVIEW_COUNTRIES = new Set(['RU', 'BY', 'CN', 'VE', 'PK']);

const getOrCreateKycProfile = async (user) => {
  let profile = await prisma.kycProfile.findUnique({ where: { userId: user.id } });
  if (!profile) {
    profile = await prisma.kycProfile.create({
      data: {
        userId: user.id,
        provider: config.compliance.provider,
        tier: user.kycTier || 0,
        status: user.kycTier > 0 ? 'approved' : 'not_started',
        sanctionsStatus: 'not_screened',
        custodyStatus: 'not_reviewed',
      },
    });
  } else {
    const needsMigration = profile.sanctionsStatus == null || profile.custodyStatus == null;
    if (needsMigration) {
      profile = await prisma.kycProfile.update({
        where: { id: profile.id },
        data: {
          sanctionsStatus: profile.sanctionsStatus || 'not_screened',
          custodyStatus: profile.custodyStatus || 'not_reviewed',
          sanctionsScreenedAt: profile.sanctionsScreenedAt || null,
          custodyReviewedAt: profile.custodyReviewedAt || null,
          deniedReason: profile.deniedReason || null,
        },
      });
    }
  }
  return profile;
};

const calculateRiskScore = ({ amount, routeType, destinationCountry, profileRiskScore = 0 }) => {
  let score = 10;
  if (Number(amount) > 100000) score += 30;
  if (Number(amount) > 50000) score += 10;
  if (routeType === 'cross_border') score += 25;
  if (destinationCountry && destinationCountry !== 'NG') score += 15;
  score += Math.min(Math.max(Number(profileRiskScore) || 0, 0), 30);
  return Math.min(score, 100);
};

const normalizeCountry = (country) => String(country || '').trim().toUpperCase();

const screenSanctions = ({ destinationCountry, routeType }) => {
  const country = normalizeCountry(destinationCountry);
  if (country && SANCTIONS_BLOCKED_COUNTRIES.has(country)) {
    return {
      status: 'blocked',
      reason: 'Destination country is subject to sanctions screening and cannot be served.',
    };
  }
  if (country && SANCTIONS_REVIEW_COUNTRIES.has(country)) {
    return {
      status: 'review',
      reason: 'Destination country is high-risk and requires manual sanctions review.',
    };
  }
  if (routeType === 'cross_border') {
    return {
      status: 'review',
      reason: 'Cross-border transfers require manual sanctions review before settlement.',
    };
  }
  return {
    status: 'cleared',
    reason: 'Local screening passed.',
  };
};

const enforceTransactionPolicy = async ({ user, amount, routeType, destinationCountry }) => {
  const profile = await getOrCreateKycProfile(user);
  const limits = tierLimits[profile.tier] || tierLimits[0];
  const parsedAmount = Number(amount);

  if (profile.status !== 'approved') {
    throw new Error('KYC approval is required before sending money.');
  }
  if (profile.custodyStatus === 'denied') {
    throw new Error('Custody review denied this account from sending funds.');
  }
  if (profile.custodyStatus === 'review') {
    throw new Error('This account is under custody review and cannot send funds until approved.');
  }
  if (profile.sanctionsStatus === 'blocked') {
    throw new Error('Sanctions screening permanently blocks this account from transfers.');
  }
  if (profile.sanctionsStatus === 'review') {
    throw new Error('This account is under sanctions review and cannot send funds until cleared.');
  }

  if (parsedAmount > limits.single) {
    throw new Error(`This payment exceeds your tier ${profile.tier} single transaction limit.`);
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = await prisma.transaction.findMany({
    where: {
      userId: user.id,
      status: { in: ['success', 'processing', 'pending'] },
      createdAt: { gte: since },
    },
    select: { amount: true },
  });
  const dailyTotal = recent.reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  if (dailyTotal + parsedAmount > limits.daily) {
    throw new Error(`This payment exceeds your tier ${profile.tier} daily limit.`);
  }

  const sanctionsResult = profile.sanctionsStatus === 'cleared'
    ? { status: 'cleared', reason: 'Previously cleared by compliance.' }
    : screenSanctions({ destinationCountry, routeType });

  const updatedProfile = await prisma.kycProfile.update({
    where: { id: profile.id },
    data: {
      sanctionsStatus: sanctionsResult.status,
      sanctionsScreenedAt: new Date(),
      lastScreenedAt: new Date(),
    },
  });

  if (sanctionsResult.status === 'blocked') {
    throw new Error(sanctionsResult.reason);
  }
  if (sanctionsResult.status === 'review') {
    throw new Error(`This payment requires manual compliance review: ${sanctionsResult.reason}`);
  }

  const riskScore = calculateRiskScore({ amount, routeType, destinationCountry, profileRiskScore: updatedProfile.riskScore });
  if (riskScore >= 80) {
    throw new Error('This payment requires manual compliance review.');
  }

  return { profile: updatedProfile, riskScore };
};

module.exports = {
  getOrCreateKycProfile,
  enforceTransactionPolicy,
  calculateRiskScore,
};
