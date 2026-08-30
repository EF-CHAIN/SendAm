const config = require('../config/env');
const prisma = require('../common/prisma');
const logger = require('../utils/logger');
const smileId = require('./smileId.provider');
const { assertValidAmount, add, compare, formatUnits, getAssetRule, parseUnits } = require('../utils/money');
const { getPolicyConversionSnapshot, PolicyError, POLICY_ERROR_CODES } = require('../pricing/policyRate');

const defaultTierLimits = {
  0: { daily: '0.00', single: '0.00' },
  1: { daily: '50000.00', single: '20000.00' },
  2: { daily: '500000.00', single: '200000.00' },
  3: { daily: '5000000.00', single: '1000000.00' },
};

const policyCurrency = () => String(config.compliance?.policyCurrency || 'NGN').trim().toUpperCase();

const canonicalizePolicyAmount = (value, currency) => {
  const rule = getAssetRule(currency);
  return formatUnits(parseUnits(String(value), rule.precision, { rejectExcessPrecision: false }), rule.precision);
};

const tierLimitsFor = (tier) => {
  const configured = config.compliance?.tierLimits || defaultTierLimits;
  const limits = configured[tier] || configured[0] || defaultTierLimits[0];
  const currency = policyCurrency();
  return {
    daily: canonicalizePolicyAmount(limits.daily, currency),
    single: canonicalizePolicyAmount(limits.single, currency),
  };
};

const throwDailyIncomplete = () => {
  throw new PolicyError(
    POLICY_ERROR_CODES.DAILY_TOTAL_INCOMPLETE,
    'Recent payments are missing a reference-currency amount; this payment cannot be evaluated against daily limits.',
  );
};

const storedReferenceAmount = (transaction, currency) => {
  if (!transaction || String(transaction.fiatCurrency || '').trim().toUpperCase() !== currency) {
    throwDailyIncomplete();
  }
  try {
    return canonicalizePolicyAmount(transaction.fiatAmount, currency);
  } catch (_error) {
    throwDailyIncomplete();
  }
};

// Legacy country sets (deprecated — retained for fail-safe fallback only)
const SANCTIONS_BLOCKED_COUNTRIES = new Set(['KP', 'IR', 'SY', 'CU', 'SD', 'SDN']);
const SANCTIONS_REVIEW_COUNTRIES = new Set(['RU', 'BY', 'CN', 'VE', 'PK']);

// Screening provider interface — implementations must match this contract
const createScreeningProvider = () => {
  const providerName = config.compliance?.screeningProvider || 'static';
  
  if (providerName === 'static') {
    // Static fallback provider — uses legacy country sets
    // DEPRECATED: Only for development/test or emergency fallback
    return {
      name: 'static',
      version: 'legacy-country-codes',
      screen: async ({ subjects }) => {
        const results = [];
        for (const subject of subjects) {
          const country = String(subject.country || '').trim().toUpperCase();
          let status = 'cleared';
          let reason = 'Static screening passed (legacy country codes).';
          
          if (SANCTIONS_BLOCKED_COUNTRIES.has(country)) {
            status = 'blocked';
            reason = `Country ${country} is on the static blocked list.`;
          } else if (SANCTIONS_REVIEW_COUNTRIES.has(country)) {
            status = 'review';
            reason = `Country ${country} is on the static review list.`;
          }
          
          results.push({
            subjectId: subject.id,
            subjectType: subject.type,
            status,
            reason,
            matches: [],
            provider: 'static',
            listVersion: 'legacy-country-codes',
          });
        }
        return { results, provider: 'static', listVersion: 'legacy-country-codes' };
      },
    };
  }
  
  // Placeholder for external provider integration (e.g., ComplyAdvantage, Refinitiv, Dow Jones)
  // When a real provider is configured, implement the screen() method to call their API
  // and normalize results to the internal format below.
  return {
    name: providerName,
    version: 'unknown',
    screen: async () => {
      throw new Error(`Screening provider "${providerName}" not implemented. Set COMPLIANCE_SCREENING_PROVIDER=static for legacy fallback.`);
    },
  };
};

const screeningProvider = createScreeningProvider();

// Screening result statuses
const SCREENING_STATUS = Object.freeze({
  CLEARED: 'cleared',
  REVIEW: 'review',
  BLOCKED: 'blocked',
  ERROR: 'error',
});

// Subject types for screening
const SUBJECT_TYPE = Object.freeze({
  CUSTOMER: 'customer',
  BENEFICIAL_OWNER: 'beneficial_owner',
  RECIPIENT: 'recipient',
});

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

const validateApplicant = (applicant) => {
  const required = ['country', 'idType', 'idNumber', 'firstName', 'lastName'];
  const missing = required.filter((field) => !String(applicant[field] || '').trim());
  if (missing.length) {
    const error = new Error(`Missing required KYC fields: ${missing.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }
};

const startKycVerification = async ({ user, applicant }) => {
  if (config.compliance.provider !== 'smileid') {
    const error = new Error(`Unsupported KYC provider: ${config.compliance.provider}`);
    error.statusCode = 503;
    throw error;
  }
  validateApplicant(applicant);
  const profile = await getOrCreateKycProfile(user);

  // A provider job id is stable for the profile. Repeated client requests and
  // retry-after-timeout submissions therefore cannot create multiple jobs.
  if (profile.status === 'pending' && profile.providerReference) return profile;
  const jobId = profile.providerReference || `sendam-${profile.id}`;
  await prisma.kycProfile.update({
    where: { id: profile.id },
    data: {
      provider: 'smileid',
      providerReference: jobId,
      status: 'pending',
      deniedReason: null,
    },
  });

  try {
    await smileId.submitVerification({
      jobId,
      userId: user.id,
      phoneNumber: user.phoneNumber,
      applicant,
    });
  } catch (error) {
    // The provider may have accepted a request before a timeout. Preserve the
    // stable job id and flag it for recovery; a retry uses that same id.
    await prisma.kycProfile.update({
      where: { id: profile.id },
      data: { status: 'review', deniedReason: 'KYC provider submission requires operator recovery' },
    });
    logger.error('kyc_submission_failed', { profileId: profile.id, provider: 'smileid', message: error.message });
    error.statusCode = error.statusCode || 502;
    throw error;
  }

  logger.info('kyc_submission_accepted', { profileId: profile.id, provider: 'smileid', jobId });
  return prisma.kycProfile.findUnique({ where: { id: profile.id } });
};

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
} = require('./kycDecision.service');

const callbackDecision = (resultCode) => {
  const decision = evaluateKycDecision({ providerResultCode: resultCode });
  return {
    status: decision.status,
    tier: decision.tier,
    deniedReason: decision.reason,
  };
};

const processSmileIdCallback = async (payload) => {
  if (!smileId.verifyCallback({ signature: payload.signature, timestamp: payload.timestamp })) {
    const error = new Error('Invalid or expired Smile ID callback signature');
    error.statusCode = 401;
    throw error;
  }

  const partnerParams = payload.PartnerParams || payload.partner_params || {};
  const jobId = partnerParams.job_id;
  const userId = partnerParams.user_id;
  if (!jobId || !userId || !payload.ResultCode) {
    const error = new Error('Malformed Smile ID callback');
    error.statusCode = 400;
    throw error;
  }
  const eventId = cryptoHash(`${payload.signature}:${payload.timestamp}`);
  const decision = callbackDecision(payload.ResultCode);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const profile = await tx.kycProfile.findFirst({
        where: { provider: 'smileid', providerReference: jobId, userId },
      });
      if (!profile) {
        const error = new Error('Smile ID callback does not match a KYC job');
        error.statusCode = 202;
        throw error;
      }

      await tx.kycWebhookEvent.create({
        data: {
          provider: 'smileid',
          providerEventId: eventId,
          profileId: profile.id,
          resultCode: String(payload.ResultCode),
        },
      });

      const nextRiskScore = decision.status === KYC_STATUSES.APPROVED ? profile.riskScore : Math.max(profile.riskScore, 50);

      const updated = await syncKycAndRiskState({
        userId: profile.userId,
        tier: decision.tier,
        status: decision.status,
        riskScore: nextRiskScore,
        deniedReason: decision.deniedReason,
        metadata: {
          resultCode: String(payload.ResultCode),
          resultText: String(payload.ResultText || ''),
          smileJobId: String(payload.SmileJobID || ''),
          verifiedAt: new Date().toISOString(),
        },
        actorType: 'provider',
        actorId: 'smileid',
        tx,
      });

      return updated;
    });
    logger.info('kyc_callback_processed', { profileId: result.id, status: result.status, resultCode: String(payload.ResultCode) });
    return { duplicate: false, profile: result };
  } catch (error) {
    if (error.code === 'P2002') {
      logger.info('kyc_callback_duplicate', { provider: 'smileid', eventId });
      return { duplicate: true };
    }
    throw error;
  }
};

const enforceTransactionPolicy = async ({
  user,
  amount,
  asset = 'NGN',
  routeType,
  destinationCountry,
  recipientPhoneNumber,
  destination,
  sessionTrust = 'trusted',
  tx = prisma,
  now,
  fetchFiatRate,
  fetchCryptoUsdRate,
}) => {
  const profile = await getOrCreateKycProfile(user);

  // Enforce tier and risk-adjusted activity limits before moving funds (#309)
  const limitResult = await enforceWalletActivityLimit({
    user,
    profile,
    operation: 'send',
    amount,
    asset,
    sessionTrust,
    tx,
    now,
    ...(fetchFiatRate ? { fetchFiatRate } : {}),
    ...(fetchCryptoUsdRate ? { fetchCryptoUsdRate } : {}),
  });

  // Use provider-based screening with full audit trail
  const sanctionsResult = await screenSanctions({
    user,
    destinationCountry,
    routeType,
    recipientPhoneNumber,
    destination,
    tx,
  });

  if (sanctionsResult.status === SCREENING_STATUS.BLOCKED) {
    throw new Error(sanctionsResult.reason);
  }
  if (sanctionsResult.status === SCREENING_STATUS.REVIEW) {
    throw new Error(`This payment requires manual compliance review: ${sanctionsResult.reason}`);
  }

  const riskScore = calculateRiskScore({
    amount: limitResult.policySnapshot.convertedAmount,
    asset: getPolicyCurrency(),
    routeType,
    destinationCountry,
    profileRiskScore: profile.riskScore,
  });

  if (riskScore >= RISK_THRESHOLDS.CRITICAL_MIN) {
    throw new Error('This payment requires manual compliance review.');
  }

  return { profile, riskScore, policySnapshot: limitResult.policySnapshot, limits: limitResult.limits };
};

module.exports = {
  getOrCreateKycProfile,
  enforceTransactionPolicy,
  calculateRiskScore,
  startKycVerification,
  processSmileIdCallback,
  callbackDecision,
  KYC_STATUSES,
  SANCTIONS_STATUSES,
  CUSTODY_STATUSES,
  RISK_THRESHOLDS,
  classifyRiskScore,
  evaluateKycDecision,
  getActivityLimits,
  syncKycAndRiskState,
  enforceWalletActivityLimit,
  PolicyError,
  POLICY_ERROR_CODES,
};
