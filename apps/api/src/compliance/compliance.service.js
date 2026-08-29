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

const callbackDecision = (resultCode) => {
  if (['1020', '1021'].includes(String(resultCode))) return { status: 'approved', tier: 1, deniedReason: null };
  if (String(resultCode) === '1022') return { status: 'rejected', tier: 0, deniedReason: 'Identity details did not match' };
  return { status: 'review', tier: 0, deniedReason: 'Provider result requires manual review' };
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
      const updated = await tx.kycProfile.update({
        where: { id: profile.id },
        data: {
          ...decision,
          riskScore: decision.status === 'approved' ? profile.riskScore : Math.max(profile.riskScore, 50),
          metadata: {
            resultCode: String(payload.ResultCode),
            resultText: String(payload.ResultText || ''),
            smileJobId: String(payload.SmileJobID || ''),
            verifiedAt: new Date().toISOString(),
          },
        },
      });
      await tx.user.update({
        where: { id: profile.userId },
        data: { kycTier: updated.tier, riskScore: updated.riskScore },
      });
      await tx.auditLog.create({
        data: {
          actorType: 'provider',
          actorId: 'smileid',
          action: 'kyc.callback.processed',
          entityType: 'KycProfile',
          entityId: profile.id,
          metadata: { resultCode: String(payload.ResultCode), status: updated.status },
        },
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

const cryptoHash = (value) => require('crypto').createHash('sha256').update(value).digest('hex');

const calculateRiskScore = ({ amount, asset, routeType, destinationCountry, profileRiskScore = 0 }) => {
  const riskAsset = asset || policyCurrency();
  const normalizedAmount = canonicalizePolicyAmount(amount, riskAsset);
  let score = 10;
  if (compare(normalizedAmount, canonicalizePolicyAmount('100000.00', riskAsset), riskAsset) > 0) score += 30;
  if (compare(normalizedAmount, canonicalizePolicyAmount('50000.00', riskAsset), riskAsset) > 0) score += 10;
  if (routeType === 'cross_border') score += 25;
  if (destinationCountry && destinationCountry !== 'NG') score += 15;
  score += Math.min(Math.max(Number(profileRiskScore) || 0, 0), 30);
  return Math.min(score, 100);
};

const normalizeCountry = (country) => String(country || '').trim().toUpperCase();

// Build screening subjects for a transaction
const buildScreeningSubjects = ({ user, destinationCountry, recipientPhoneNumber, destination }) => {
  const subjects = [];
  
  // Customer (sender)
  subjects.push({
    id: `customer:${user.id}`,
    type: SUBJECT_TYPE.CUSTOMER,
    name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.phoneNumber,
    country: user.country || 'NG',
    identifiers: {
      phoneNumber: user.phoneNumber,
      userId: String(user.id),
    },
  });
  
  // Recipient (if phone number provided)
  if (recipientPhoneNumber) {
    subjects.push({
      id: `recipient:${recipientPhoneNumber}`,
      type: SUBJECT_TYPE.RECIPIENT,
      phoneNumber: recipientPhoneNumber,
      country: destinationCountry || 'NG',
      identifiers: {
        phoneNumber: recipientPhoneNumber,
      },
    });
  }
  
  // Destination address (if Stellar address provided)
  if (destination) {
    subjects.push({
      id: `destination:${destination}`,
      type: SUBJECT_TYPE.RECIPIENT,
      address: destination,
      country: destinationCountry || 'NG',
      identifiers: {
        stellarAddress: destination,
      },
    });
  }
  
  // Destination country (for country-based screening when no specific recipient)
  // This ensures sanctions screening works for cross-border payments even without
  // a registered recipient phone number or Stellar address.
  if (destinationCountry && !recipientPhoneNumber && !destination) {
    subjects.push({
      id: `destination-country:${destinationCountry}`,
      type: SUBJECT_TYPE.RECIPIENT,
      country: destinationCountry,
      identifiers: {
        destinationCountry,
      },
    });
  }
  
  return subjects;
};

// Persist screening results with full audit trail
const persistScreeningResults = async ({ profileId, subjects, results, tx }) => {
  const now = new Date();
  
  for (const result of results) {
    await tx.sanctionsScreeningResult.create({
      data: {
        profileId,
        subjectId: result.subjectId,
        subjectType: result.subjectType,
        provider: result.provider,
        listVersion: result.listVersion,
        status: result.status,
        reason: result.reason,
        matches: result.matches || [],
        screenedAt: now,
        decisionOwner: result.status === SCREENING_STATUS.REVIEW ? 'system' : null,
      },
    });
  }
  
  // Determine overall profile sanctions status from individual results
  const hasBlocked = results.some((r) => r.status === SCREENING_STATUS.BLOCKED);
  const hasReview = results.some((r) => r.status === SCREENING_STATUS.REVIEW);
  
  let overallStatus = SCREENING_STATUS.CLEARED;
  if (hasBlocked) overallStatus = SCREENING_STATUS.BLOCKED;
  else if (hasReview) overallStatus = SCREENING_STATUS.REVIEW;
  
  await tx.kycProfile.update({
    where: { id: profileId },
    data: {
      sanctionsStatus: overallStatus,
      sanctionsScreenedAt: now,
      lastScreenedAt: now,
    },
  });
  
  return overallStatus;
};

// Main screening function using configured provider
const screenSanctions = async ({ user, destinationCountry, routeType, recipientPhoneNumber, destination, tx = prisma }) => {
  // Check if we have a recent cached result that's still valid
  const profile = await getOrCreateKycProfile(user);
  const maxAgeMs = Number(config.compliance?.screeningMaxAgeMs || 24 * 60 * 60 * 1000); // 24 hours default
  
  if (
    profile.sanctionsScreenedAt &&
    Date.now() - new Date(profile.sanctionsScreenedAt).getTime() < maxAgeMs &&
    profile.sanctionsStatus !== SCREENING_STATUS.REVIEW &&
    profile.sanctionsStatus !== SCREENING_STATUS.BLOCKED
  ) {
    // Return cached result for cleared profiles within TTL
    return {
      status: profile.sanctionsStatus,
      reason: 'Previously cleared by compliance (cached).',
      cached: true,
    };
  }
  
  // Build subjects to screen
  const subjects = buildScreeningSubjects({ user, destinationCountry, recipientPhoneNumber, destination });
  
  try {
    // Call screening provider
    const screeningResult = await screeningProvider.screen({ subjects });
    
    // Persist results with audit trail
    const overallStatus = await persistScreeningResults({
      profileId: profile.id,
      subjects,
      results: screeningResult.results,
      tx,
    });
    
    // Log screening completion
    await tx.auditLog.create({
      data: {
        actorType: 'system',
        actorId: 'screening',
        action: 'sanctions.screening.completed',
        entityType: 'KycProfile',
        entityId: profile.id,
        metadata: {
          provider: screeningResult.provider,
          listVersion: screeningResult.listVersion,
          subjects: subjects.map((s) => ({ id: s.id, type: s.type })),
          results: screeningResult.results.map((r) => ({
            subjectId: r.subjectId,
            status: r.status,
            reason: r.reason,
          })),
          overallStatus,
        },
      },
    });
    
    return {
      status: overallStatus,
      reason: screeningResult.results.find((r) => r.status !== SCREENING_STATUS.CLEARED)?.reason || 'Screening passed.',
      cached: false,
      details: screeningResult.results,
    };
  } catch (error) {
    logger.error('sanctions_screening_failed', {
      profileId: profile.id,
      provider: screeningProvider.name,
      error: error.message,
    });
    
    // Fail-safe: if screening is unavailable and profile was previously cleared, allow with warning
    if (profile.sanctionsStatus === SCREENING_STATUS.CLEARED && profile.sanctionsScreenedAt) {
      const staleness = Date.now() - new Date(profile.sanctionsScreenedAt).getTime();
      const maxStaleness = Number(config.compliance?.screeningMaxStalenessMs || 72 * 60 * 60 * 1000); // 72 hours
      
      if (staleness < maxStaleness) {
        logger.warn('sanctions_screening_unavailable_using_stale_cleared', {
          profileId: profile.id,
          stalenessMs: staleness,
        });
        return {
          status: SCREENING_STATUS.CLEARED,
          reason: 'Screening temporarily unavailable; using previously cleared result.',
          cached: true,
          stale: true,
        };
      }
    }
    
    // If no cached result or stale, fail safe to review (don't leak watchlist details)
    logger.warn('sanctions_screening_unavailable_fail_safe_review', {
      profileId: profile.id,
      provider: screeningProvider.name,
    });
    
    return {
      status: SCREENING_STATUS.REVIEW,
      reason: 'Sanctions screening temporarily unavailable; manual review required.',
      cached: false,
      error: true,
    };
  }
};

// Legacy sync screenSanctions for backward compatibility (deprecated)
const screenSanctionsLegacy = ({ destinationCountry, routeType }) => {
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

const enforceTransactionPolicy = async ({ user, amount, asset = 'NGN', routeType, destinationCountry, tx = prisma, now, fetchFiatRate, fetchCryptoUsdRate }) => {
  const profile = await getOrCreateKycProfile(user);
  const limits = tierLimitsFor(profile.tier);
  const referenceCurrency = policyCurrency();
  const settlementAsset = String(asset || referenceCurrency).trim().toUpperCase();
  assertValidAmount(amount, settlementAsset);

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

  const policySnapshot = await getPolicyConversionSnapshot({
    sourceAsset: settlementAsset,
    amount,
    now,
    ...(fetchFiatRate ? { fetchFiatRate } : {}),
    ...(fetchCryptoUsdRate ? { fetchCryptoUsdRate } : {}),
  });
  const convertedAmount = policySnapshot.convertedAmount;

  if (compare(convertedAmount, limits.single, referenceCurrency) > 0) {
    throw new Error(`This payment exceeds your tier ${profile.tier} single transaction limit.`);
  }

  const since = new Date((now instanceof Date ? now.getTime() : Date.now()) - 24 * 60 * 60 * 1000);
  const recent = await tx.transaction.findMany({
    where: {
      userId: user.id,
      type: 'send',
      status: { in: ['success', 'processing', 'pending'] },
      createdAt: { gte: since },
    },
    select: { amount: true, asset: true, fiatAmount: true, fiatCurrency: true },
  });
  const zeroAmount = formatUnits(0n, getAssetRule(referenceCurrency).precision);
  const dailyTotal = recent.reduce(
    (sum, t) => add(sum, storedReferenceAmount(t, referenceCurrency), referenceCurrency),
    zeroAmount,
  );
  if (compare(add(dailyTotal, convertedAmount, referenceCurrency), limits.daily, referenceCurrency) > 0) {
    throw new Error(`This payment exceeds your tier ${profile.tier} daily limit.`);
  }

  // Use new provider-based screening with full audit trail
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
    amount: convertedAmount,
    asset: referenceCurrency,
    routeType,
    destinationCountry,
    profileRiskScore: updatedProfile.riskScore,
  });
  if (riskScore >= 80) {
    throw new Error('This payment requires manual compliance review.');
  }

  return { profile: updatedProfile, riskScore, policySnapshot };
};

module.exports = {
  getOrCreateKycProfile,
  enforceTransactionPolicy,
  calculateRiskScore,
  startKycVerification,
  processSmileIdCallback,
  callbackDecision,
  PolicyError,
  POLICY_ERROR_CODES,
};
