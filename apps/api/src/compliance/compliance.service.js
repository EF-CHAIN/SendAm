const config = require('../config/env');
const prisma = require('../common/prisma');

const tierLimits = {
  0: { daily: 0, single: 0 },
  1: { daily: Number(process.env.TIER_1_DAILY_LIMIT || 50000), single: Number(process.env.TIER_1_SINGLE_LIMIT || 20000) },
  2: { daily: Number(process.env.TIER_2_DAILY_LIMIT || 500000), single: Number(process.env.TIER_2_SINGLE_LIMIT || 200000) },
  3: { daily: Number(process.env.TIER_3_DAILY_LIMIT || 5000000), single: Number(process.env.TIER_3_SINGLE_LIMIT || 1000000) },
};

const getOrCreateKycProfile = async (user) => {
  let profile = await prisma.kycProfile.findUnique({ where: { userId: user.id } });
  if (!profile) {
    profile = await prisma.kycProfile.create({
      data: {
        userId: user.id,
        provider: config.compliance.provider,
        tier: user.kycTier || 0,
        status: user.kycTier > 0 ? 'approved' : 'not_started',
      },
    });
  }
  return profile;
};

const calculateRiskScore = ({ amount, routeType, destinationCountry }) => {
  let score = 10;
  if (Number(amount) > 100000) score += 30;
  if (routeType === 'cross_border') score += 25;
  if (destinationCountry && destinationCountry !== 'NG') score += 15;
  return Math.min(score, 100);
};

const enforceTransactionPolicy = async ({ user, amount, routeType, destinationCountry }) => {
  const profile = await getOrCreateKycProfile(user);
  const limits = tierLimits[profile.tier] || tierLimits[0];
  const parsedAmount = Number(amount);

  if (profile.status !== 'approved') {
    throw new Error('KYC approval is required before sending money.');
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

  const riskScore = calculateRiskScore({ amount, routeType, destinationCountry });
  if (riskScore >= 80) {
    throw new Error('This payment requires manual compliance review.');
  }

  return { profile, riskScore };
};

module.exports = {
  getOrCreateKycProfile,
  enforceTransactionPolicy,
  calculateRiskScore,
};
