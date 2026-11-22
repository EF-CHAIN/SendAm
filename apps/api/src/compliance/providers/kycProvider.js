const smileId = require('./smileId');
const dojah = require('./dojah');
const config = require('../../config/env');
const { ProviderSkippedError } = require('../providerErrors');
const prisma = require('../../common/prisma');
const { writeAuditLog } = require('../../common/audit.service');
const { syncKycAndRiskState, KYC_STATUSES, RISK_THRESHOLDS } = require('../kycDecision.service');

function getProvider() {
  const preferred = config.compliance.provider || 'smileid';
  if (preferred === 'dojah' && config.compliance.dojah.appId && config.compliance.dojah.secretKey) {
    return { name: 'dojah', submitBvn: dojah.submitBvnVerification, submitNin: dojah.submitNinVerification };
  }
  if (config.compliance.smileId.partnerId && config.compliance.smileId.apiKey) {
    return { name: 'smileid', submitBvn: smileId.submitBvnVerification, submitNin: smileId.submitNinVerification };
  }
  return null;
}

async function verifyIdentity({ user, idType, idNumber, applicantData }) {
  const provider = getProvider();
  if (!provider) {
    throw new ProviderSkippedError('No KYC provider configured');
  }

  const jobId = `sendam-kyc-${user.id}-${Date.now()}`;
  const phoneNumber = user.phoneNumber;

  let result;
  if (idType === 'BVN') {
    result = await provider.submitBvn({ jobId, userId: user.id, phoneNumber, applicant: applicantData });
  } else if (idType === 'NIN') {
    result = await provider.submitNin({ jobId, userId: user.id, phoneNumber, applicant: applicantData });
  } else {
    throw new Error(`Unsupported ID type: ${idType}`);
  }

  const verificationRef = result.providerReference || jobId;

  await prisma.kycVerification.create({
    data: {
      userId: user.id,
      provider: provider.name,
      idType,
      idNumber,
      status: 'pending',
      providerReference: verificationRef,
      metadata: { ...applicantData, jobId },
    },
  });

  await writeAuditLog({
    actorType: 'user',
    actorId: user.id,
    action: 'kyc.verification.submitted',
    entityType: 'User',
    entityId: user.id,
    metadata: { provider: provider.name, idType, idNumber, providerReference: verificationRef },
  });

  return { verificationRef, provider: provider.name, status: 'pending' };
}

async function processProviderCallback({ provider, payload, signature, timestamp }) {
  let verified = false;
  let resultCode = null;
  let providerReference = null;

  if (provider === 'smileid') {
    if (!smileId.verifyCallback({ signature, timestamp })) {
      throw new Error('Invalid Smile ID callback signature');
    }
    verified = payload.ResultCode === '1020' || payload.ResultCode === '1021';
    resultCode = payload.ResultCode;
    providerReference = payload.PartnerParams?.job_id;
  } else if (provider === 'dojah') {
    verified = payload.entity?.verified === true;
    resultCode = verified ? '1020' : '1022';
    providerReference = payload.entity?.reference;
  } else {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const verification = await prisma.kycVerification.findFirst({
    where: { providerReference, provider },
    include: { user: true },
  });

  if (!verification) {
    throw new Error('Verification record not found');
  }

  const status = verified ? 'verified' : 'rejected';
  await prisma.kycVerification.update({
    where: { id: verification.id },
    data: {
      status,
      resultCode: String(resultCode),
      verifiedAt: verified ? new Date() : null,
      metadata: { ...verification.metadata, callbackPayload: payload },
    },
  });

  if (verified) {
    await syncKycAndRiskState({
      userId: verification.userId,
      tier: 1,
      status: KYC_STATUSES.APPROVED,
      riskScore: Math.min(RISK_THRESHOLDS.LOW_MAX, verification.user.riskScore || 0),
      metadata: {
        kycProvider: provider,
        idType: verification.idType,
        idNumber: verification.idNumber,
        providerReference,
        verifiedAt: new Date().toISOString(),
      },
      actorType: 'provider',
      actorId: provider,
    });

    await writeAuditLog({
      actorType: 'provider',
      actorId: provider,
      action: 'kyc.verification.approved',
      entityType: 'User',
      entityId: verification.userId,
      metadata: { provider, idType: verification.idType, idNumber: verification.idNumber, providerReference },
    });
  } else {
    await writeAuditLog({
      actorType: 'provider',
      actorId: provider,
      action: 'kyc.verification.rejected',
      entityType: 'User',
      entityId: verification.userId,
      metadata: { provider, idType: verification.idType, idNumber: verification.idNumber, providerReference, resultCode },
    });
  }

  return { verified, status, providerReference };
}

module.exports = {
  verifyIdentity,
  processProviderCallback,
};