const { sendSuccess, sendError } = require('../utils/response');
const { getOrCreateKycProfile } = require('./compliance.service');
const { hashPin } = require('./pin.service');
const prisma = require('../common/prisma');
const { withIdAlias } = require('../common/records');

const getProfile = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { phoneNumber: req.params.phone } });
    if (!user) return sendError(res, 'User not found', 404);
    const profile = await getOrCreateKycProfile(user);
    return sendSuccess(res, withIdAlias(profile));
  } catch (error) {
    next(error);
  }
};

const startKyc = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { phoneNumber: req.body.phoneNumber } });
    if (!user) return sendError(res, 'User not found', 404);
    const existing = await getOrCreateKycProfile(user);
    const profile = await prisma.kycProfile.update({
      where: { id: existing.id },
      data: {
        status: 'pending',
        providerReference: req.body.providerReference,
      },
    });
    return sendSuccess(res, withIdAlias(profile), 'KYC started');
  } catch (error) {
    next(error);
  }
};

const reviewKyc = async (req, res, next) => {
  try {
    const profile = await prisma.kycProfile.findUnique({ where: { id: req.params.id } });
    if (!profile) return sendError(res, 'KYC profile not found', 404);
    const reviewed = await prisma.kycProfile.update({
      where: { id: profile.id },
      data: {
        status: req.body.status,
        tier: Number(req.body.tier ?? profile.tier),
        riskScore: Number(req.body.riskScore ?? profile.riskScore),
      },
    });
    await prisma.user.update({
      where: { id: reviewed.userId },
      data: { kycTier: reviewed.tier, riskScore: reviewed.riskScore },
    });
    return sendSuccess(res, withIdAlias(reviewed), 'KYC profile reviewed');
  } catch (error) {
    next(error);
  }
};

const setPin = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { phoneNumber: req.body.phoneNumber } });
    if (!user) return sendError(res, 'User not found', 404);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        pinHash: hashPin(req.body.pin),
        pinSetAt: new Date(),
      },
    });
    return sendSuccess(res, null, 'PIN set');
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getProfile,
  startKyc,
  reviewKyc,
  setPin,
};
