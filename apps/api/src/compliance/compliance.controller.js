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

    const allowedStatuses = ['not_started', 'pending', 'approved', 'rejected', 'review'];
    const allowedSanctions = ['not_screened', 'cleared', 'review', 'blocked'];
    const allowedCustody = ['not_reviewed', 'approved', 'review', 'denied'];

    const status = req.body.status ?? profile.status;
    const sanctionsStatus = req.body.sanctionsStatus ?? profile.sanctionsStatus;
    const custodyStatus = req.body.custodyStatus ?? profile.custodyStatus;

    if (!allowedStatuses.includes(status)) return sendError(res, 'Invalid KYC status', 400);
    if (!allowedSanctions.includes(sanctionsStatus)) return sendError(res, 'Invalid sanctions status', 400);
    if (!allowedCustody.includes(custodyStatus)) return sendError(res, 'Invalid custody status', 400);

    const reviewed = await prisma.kycProfile.update({
      where: { id: profile.id },
      data: {
        status,
        tier: Number(req.body.tier ?? profile.tier),
        riskScore: Number(req.body.riskScore ?? profile.riskScore),
        sanctionsStatus,
        custodyStatus,
        deniedReason: req.body.deniedReason ?? profile.deniedReason,
        sanctionsScreenedAt: sanctionsStatus === 'cleared' || sanctionsStatus === 'blocked' || sanctionsStatus === 'review' ? new Date() : profile.sanctionsScreenedAt,
        custodyReviewedAt: custodyStatus === 'approved' || custodyStatus === 'denied' || custodyStatus === 'review' ? new Date() : profile.custodyReviewedAt,
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
