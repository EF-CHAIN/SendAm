'use strict';

// Regional KYC verification for Ghana (Ghana Card) and Kenya (National ID) (#983).
//
// KYC_PROVIDER=dojah: synchronous Dojah lookup for Ghana Card (/api/v1/gh/kyc)
//   and Kenyan National ID (/api/v1/ke/kyc). Name and date of birth are matched
//   against the registry record. A match elevates the user to Tier 1 immediately,
//   raising transaction and daily limits.
// KYC_PROVIDER=smileid: delegates to Smile ID verification job for Ghana / Kenya.
//
// Security: Raw national ID numbers and Ghana Card numbers are NEVER stored or
// logged. An HMAC-SHA256 hash (keyed with KYC_ID_HASH_SECRET) and the last 4
// characters are stored. The hash prevents an ID from being used across multiple
// SendAm accounts.

const crypto = require('crypto');
const prisma = require('../../common/prisma');
const config = require('../../config/env');
const logger = require('../../utils/logger');
const { writeAuditLog } = require('../../common/audit.service');
const { getOrCreateKycProfile, startKycVerification } = require('../compliance.service');
const { syncKycAndRiskState, KYC_STATUSES } = require('../kycDecision.service');
const dojah = require('./dojah');

const SUPPORTED_COUNTRIES = Object.freeze({
  GH: 'GH',
  KE: 'KE',
});

const SUPPORTED_ID_TYPES = Object.freeze({
  GHANA_CARD: 'GHANA_CARD',
  KENYA_ID: 'KENYA_ID',
});

const COUNTRY_DEFAULT_ID_TYPE = Object.freeze({
  GH: SUPPORTED_ID_TYPES.GHANA_CARD,
  KE: SUPPORTED_ID_TYPES.KENYA_ID,
});

const MAX_ATTEMPTS_PER_DAY = 5;

const kycError = (message, statusCode, code) => Object.assign(new Error(message), { statusCode, code });

const hashIdNumber = (idType, idNumber, secret = config.compliance.kycIdHashSecret) => {
  if (!secret) throw kycError('KYC identity hashing is not configured.', 503, 'KYC_HASH_SECRET_MISSING');
  return crypto.createHmac('sha256', secret).update(`${idType}:${idNumber}`, 'utf8').digest('hex');
};

const normalizeCountry = (country) => {
  const c = String(country || '').trim().toUpperCase();
  if (['GH', 'GHA', 'GHANA'].includes(c)) return 'GH';
  if (['KE', 'KEN', 'KENYA'].includes(c)) return 'KE';
  throw kycError('Supported countries are Ghana (GH) and Kenya (KE).', 400, 'KYC_INVALID_COUNTRY');
};

const normalizeIdType = (country, rawType) => {
  const normCountry = normalizeCountry(country);
  if (!rawType) return COUNTRY_DEFAULT_ID_TYPE[normCountry];

  const t = String(rawType).trim().toUpperCase().replace(/[-_\s]/g, '');
  if (['GHANACARD', 'GHANA', 'GHA', 'NATIONALID', 'CARD'].includes(t) && normCountry === 'GH') {
    return SUPPORTED_ID_TYPES.GHANA_CARD;
  }
  if (['KENYAID', 'KENYA', 'KE', 'NATIONALID', 'ID'].includes(t) && normCountry === 'KE') {
    return SUPPORTED_ID_TYPES.KENYA_ID;
  }
  if (t === 'GHANACARD') return SUPPORTED_ID_TYPES.GHANA_CARD;
  if (t === 'KENYAID') return SUPPORTED_ID_TYPES.KENYA_ID;

  throw kycError(`Invalid idType for ${normCountry}: must be ${normCountry === 'GH' ? 'GHANA_CARD' : 'KENYA_ID'}.`, 400, 'KYC_INVALID_ID_TYPE');
};

/**
 * Validates and formats national ID numbers:
 * - Ghana Card: GHA-XXXXXXXXX-X (9 digits, 1 check digit)
 * - Kenyan National ID: 7 to 9 digits
 */
const formatAndValidateIdNumber = (idType, rawNumber) => {
  const raw = String(rawNumber || '').trim();
  if (!raw) {
    throw kycError('idNumber is required.', 400, 'KYC_INVALID_ID_NUMBER');
  }

  if (idType === SUPPORTED_ID_TYPES.GHANA_CARD) {
    const cleaned = raw.toUpperCase().replace(/\s/g, '');
    const match = cleaned.match(/^GHA-?(\d{9})-?(\d)$/);
    if (!match) {
      throw kycError('Ghana Card must be in the format GHA-XXXXXXXXX-X.', 400, 'KYC_INVALID_ID_NUMBER');
    }
    return `GHA-${match[1]}-${match[2]}`;
  }

  if (idType === SUPPORTED_ID_TYPES.KENYA_ID) {
    const cleaned = raw.replace(/\s/g, '');
    if (!/^\d{7,9}$/.test(cleaned)) {
      throw kycError('Kenyan National ID must be 7 to 9 digits.', 400, 'KYC_INVALID_ID_NUMBER');
    }
    return cleaned;
  }

  throw kycError(`Unsupported ID type: ${idType}`, 400, 'KYC_INVALID_ID_TYPE');
};

const normalizeName = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[^a-z]/g, '');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Normalizes YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY and DD-Mon-YYYY to YYYY-MM-DD. */
const normalizeDob = (value) => {
  const s = String(value || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  let y; let mo; let d;
  if (m) [, y, mo, d] = m;
  else if ((m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/))) [, d, mo, y] = m;
  else if ((m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{4})$/))) {
    [, d, , y] = m;
    mo = MONTHS[m[2].toLowerCase()];
  }
  if (!y || !mo || !d) return null;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? null : iso;
};

/**
 * First and last name must both appear among the record's names (order-insensitive),
 * and DOB must match.
 */
const matchIdentity = (applicant, record) => {
  const recordNames = new Set(
    [record.firstName, record.middleName, record.lastName]
      .map(normalizeName)
      .filter(Boolean),
  );
  const firstName = recordNames.has(normalizeName(applicant.firstName));
  const lastName = recordNames.has(normalizeName(applicant.lastName));
  const applicantDob = normalizeDob(applicant.dob);
  const dob = Boolean(applicantDob) && applicantDob === normalizeDob(record.dob);
  return { matched: firstName && lastName && dob, firstName, lastName, dob };
};

const validateRequest = ({ country: rawCountry, idType: rawType, idNumber: rawNumber, firstName, lastName, dob }) => {
  const country = normalizeCountry(rawCountry);
  const idType = normalizeIdType(country, rawType);
  const idNumber = formatAndValidateIdNumber(idType, rawNumber);
  if (!String(firstName || '').trim() || !String(lastName || '').trim()) {
    throw kycError('First and last name are required.', 400, 'KYC_NAME_REQUIRED');
  }
  if (!normalizeDob(dob)) {
    throw kycError('Date of birth must be a valid date (YYYY-MM-DD).', 400, 'KYC_INVALID_DOB');
  }
  return { country, idType, idNumber, firstName: firstName.trim(), lastName: lastName.trim(), dob: normalizeDob(dob) };
};

const audit = (action, user, metadata) => writeAuditLog({
  actorType: 'user',
  actorId: String(user.id),
  action,
  entityType: 'User',
  entityId: String(user.id),
  metadata,
});

const recordAttempt = (data, db = prisma) => db.kycVerification.create({ data });

/**
 * Verifies a regional ID (Ghana Card or Kenya ID).
 * @returns {Promise<{status: 'verified'|'rejected'|'pending'|'already_verified', tier: number, reason?: string}>}
 */
const verifyRegionalId = async (
  { user, country: rawCountry, idType: rawType, idNumber: rawNumber, firstName, lastName, dob },
  deps = {},
) => {
  const db = deps.prisma || prisma;
  const validated = validateRequest({
    country: rawCountry,
    idType: rawType,
    idNumber: rawNumber,
    firstName,
    lastName,
    dob,
  });
  const { country, idType, idNumber } = validated;

  const idHash = hashIdNumber(idType, idNumber, deps.hashSecret);
  const idLast4 = idNumber.slice(-4);
  const profile = await getOrCreateKycProfile(user);

  if (profile.status === KYC_STATUSES.APPROVED && profile.tier >= 1) {
    return { status: 'already_verified', tier: profile.tier };
  }

  const provider = config.compliance.provider;
  if (provider !== 'dojah') {
    // Smile ID: asynchronous job
    const pending = await startKycVerification({
      user,
      applicant: {
        country,
        idType: idType === SUPPORTED_ID_TYPES.KENYA_ID ? 'NATIONAL_ID' : idType,
        idNumber,
        firstName: validated.firstName,
        lastName: validated.lastName,
        dob: validated.dob,
      },
    });
    await recordAttempt({
      userId: user.id,
      provider: 'smileid',
      idType,
      idHash,
      idLast4,
      status: 'pending',
      providerReference: pending?.providerReference || null,
      metadata: { country },
    }, db);
    return { status: 'pending', tier: profile.tier };
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const attempts = await db.kycVerification.count({
    where: { userId: user.id, createdAt: { gte: since } },
  });
  if (attempts >= MAX_ATTEMPTS_PER_DAY) {
    throw kycError('Too many verification attempts. Please try again tomorrow.', 429, 'KYC_TOO_MANY_ATTEMPTS');
  }

  const linkedElsewhere = await db.kycVerification.findFirst({
    where: { idHash, status: 'verified', userId: { not: user.id } },
    select: { id: true },
  });
  if (linkedElsewhere) {
    await recordAttempt({
      userId: user.id,
      provider,
      idType,
      idHash,
      idLast4,
      status: 'rejected',
      failureReason: 'id_linked_to_another_account',
      metadata: { country },
    }, db);
    await audit('kyc.verification.rejected', user, {
      provider, country, idType, idLast4, reason: 'id_linked_to_another_account',
    });
    return { status: 'rejected', tier: profile.tier, reason: 'id_linked_to_another_account' };
  }

  let record;
  try {
    const lookupFn = deps.lookupIdentity || dojah.lookupIdentity;
    record = await lookupFn({ idType, idNumber }, { httpGet: deps.httpGet });
  } catch (error) {
    if (error instanceof dojah.IdentityNotFoundError || error.name === 'IdentityNotFoundError') {
      await recordAttempt({
        userId: user.id,
        provider,
        idType,
        idHash,
        idLast4,
        status: 'rejected',
        failureReason: 'id_not_found',
        metadata: { country },
      }, db);
      await audit('kyc.verification.rejected', user, {
        provider, country, idType, idLast4, reason: 'id_not_found',
      });
      return { status: 'rejected', tier: profile.tier, reason: 'id_not_found' };
    }

    logger.error('regional_kyc_lookup_failed', { userId: user.id, country, idType, message: error.message });
    throw kycError(
      'Identity verification is temporarily unavailable. Please try again shortly.',
      error.statusCode === 503 ? 503 : 502,
      'KYC_PROVIDER_UNAVAILABLE',
    );
  }

  const match = matchIdentity({ firstName: validated.firstName, lastName: validated.lastName, dob: validated.dob }, record);
  const matchSummary = { firstName: match.firstName, lastName: match.lastName, dob: match.dob };

  if (!match.matched) {
    await recordAttempt({
      userId: user.id,
      provider,
      idType,
      idHash,
      idLast4,
      status: 'rejected',
      providerReference: record.reference,
      failureReason: 'details_mismatch',
      metadata: { country, match: matchSummary },
    }, db);
    await audit('kyc.verification.rejected', user, {
      provider, country, idType, idLast4, reason: 'details_mismatch', match: matchSummary,
    });
    return { status: 'rejected', tier: profile.tier, reason: 'details_mismatch' };
  }

  await recordAttempt({
    userId: user.id,
    provider,
    idType,
    idHash,
    idLast4,
    status: 'verified',
    providerReference: record.reference,
    verifiedAt: new Date(),
    metadata: { country, match: matchSummary },
  }, db);

  const tier = Math.max(1, profile.tier || 0);
  await syncKycAndRiskState({
    userId: user.id,
    tier,
    status: KYC_STATUSES.APPROVED,
    deniedReason: null,
    metadata: {
      ...(profile.metadata || {}),
      regionalKycVerification: {
        country,
        provider,
        idType,
        idLast4,
        verifiedAt: new Date().toISOString(),
      },
    },
    actorType: 'provider',
    actorId: provider,
  });

  await audit('kyc.verification.approved', user, { provider, country, idType, idLast4, tier });
  logger.info('regional_kyc_verified', { userId: user.id, country, idType, provider });
  return { status: 'verified', tier };
};

/**
 * Parses user input from WhatsApp message for KYC.
 * Formats supported:
 *   KYC GHA-123456789-1 Kwame Mensah 1990-05-15
 *   KYC 12345678 Juma Mwangi 1988-12-05
 *   KYC GH GHA-123456789-1 Kwame Mensah 1990-05-15
 *   KYC KE 12345678 Juma Mwangi 1988-12-05
 */
const parseKycMessage = (text, defaultCountry = null) => {
  const trimmed = String(text || '').trim();
  if (!/^(?:kyc|verify)\b/i.test(trimmed)) return null;

  const rest = trimmed.replace(/^(?:kyc|verify)\b/i, '').trim();
  if (!rest) {
    return { promptOnly: true };
  }

  const parts = rest.split(/\s+/);
  if (parts.length < 4) {
    return { promptOnly: true, incomplete: true };
  }

  let country = defaultCountry;
  let sliceIdx = 0;

  const firstUpper = parts[0].toUpperCase();
  if (['GH', 'GHANA', 'GHA'].includes(firstUpper)) {
    country = 'GH';
    sliceIdx = 1;
  } else if (['KE', 'KENYA', 'KEN'].includes(firstUpper)) {
    country = 'KE';
    sliceIdx = 1;
  }

  const tokens = parts.slice(sliceIdx);
  if (tokens.length < 4) {
    return { promptOnly: true, incomplete: true, country };
  }

  const idNumber = tokens[0];
  const dob = tokens[tokens.length - 1];
  const nameTokens = tokens.slice(1, -1);
  const firstName = nameTokens[0];
  const lastName = nameTokens.slice(1).join(' ');

  if (!country) {
    if (/^GHA/i.test(idNumber)) country = 'GH';
    else if (/^\d{7,9}$/.test(idNumber)) country = defaultCountry || 'KE';
  }

  return {
    promptOnly: false,
    country,
    idNumber,
    firstName,
    lastName,
    dob,
  };
};

/**
 * Conversational WhatsApp prompt & handler for Ghana and Kenya KYC.
 * Returns true if handled.
 */
const handleRegionalKycPrompt = async ({ phoneNumber, user, text, notify, db = prisma, deps = {} }) => {
  const normPhone = String(phoneNumber || user?.phoneNumber || '');
  let defaultCountry = null;
  if (normPhone.startsWith('+233') || normPhone.startsWith('233')) defaultCountry = 'GH';
  else if (normPhone.startsWith('+254') || normPhone.startsWith('254')) defaultCountry = 'KE';

  const intent = parseKycMessage(text, defaultCountry);
  if (!intent) return false;

  const targetCountry = intent.country || defaultCountry || 'GH';

  if (intent.promptOnly) {
    if (user?.kycTier >= 1) {
      await notify(phoneNumber, 'Your SendAm account is already verified at Tier 1 with elevated transaction limits.');
      return true;
    }

    if (targetCountry === 'GH') {
      await notify(
        phoneNumber,
        'To verify your identity with your Ghana Card and elevate your limits:\n\n'
        + 'Reply in this format:\n'
        + 'KYC <Ghana Card ID> <First Name> <Last Name> <YYYY-MM-DD>\n\n'
        + 'Example:\n'
        + 'KYC GHA-123456789-1 Kwame Mensah 1990-05-15',
      );
      return true;
    }

    if (targetCountry === 'KE') {
      await notify(
        phoneNumber,
        'To verify your identity with your Kenyan National ID and elevate your limits:\n\n'
        + 'Reply in this format:\n'
        + 'KYC <National ID> <First Name> <Last Name> <YYYY-MM-DD>\n\n'
        + 'Example:\n'
        + 'KYC 12345678 Juma Mwangi 1990-05-15',
      );
      return true;
    }

    await notify(
      phoneNumber,
      'To verify your identity and elevate your limits, reply with:\n'
      + 'KYC <Country: GH/KE> <ID Number> <First Name> <Last Name> <YYYY-MM-DD>\n\n'
      + 'Example for Ghana:\nKYC GH GHA-123456789-1 Kwame Mensah 1990-05-15\n\n'
      + 'Example for Kenya:\nKYC KE 12345678 Juma Mwangi 1990-05-15',
    );
    return true;
  }

  try {
    const result = await verifyRegionalId({
      user,
      country: intent.country,
      idNumber: intent.idNumber,
      firstName: intent.firstName,
      lastName: intent.lastName,
      dob: intent.dob,
    }, { prisma: db, ...deps });

    if (result.status === 'verified') {
      await notify(
        phoneNumber,
        '✅ Identity verified successfully! Your SendAm account has been upgraded to Tier 1 with elevated send and transaction limits.',
      );
    } else if (result.status === 'already_verified') {
      await notify(phoneNumber, 'Your identity is already verified (Tier 1).');
    } else if (result.status === 'pending') {
      await notify(
        phoneNumber,
        '⏳ Your identity verification has been submitted for automated processing. You will receive an update shortly.',
      );
    } else if (result.status === 'rejected') {
      const reasonMessages = {
        details_mismatch: 'The name or date of birth provided does not match official government registry records.',
        id_not_found: 'The ID number was not found in the official registry. Please check for typos.',
        id_linked_to_another_account: 'This ID has already been verified on another account.',
      };
      const detail = reasonMessages[result.reason] || 'Identity details could not be confirmed.';
      await notify(phoneNumber, `❌ Verification failed: ${detail} Please verify your details and try again.`);
    }
  } catch (err) {
    logger.warn('whatsapp_regional_kyc_error', { userId: user?.id, error: err.message });
    await notify(phoneNumber, `⚠️ Verification could not be completed: ${err.message}`);
  }

  return true;
};

module.exports = {
  SUPPORTED_COUNTRIES,
  SUPPORTED_ID_TYPES,
  COUNTRY_DEFAULT_ID_TYPE,
  MAX_ATTEMPTS_PER_DAY,
  hashIdNumber,
  normalizeCountry,
  normalizeIdType,
  formatAndValidateIdNumber,
  normalizeName,
  normalizeDob,
  matchIdentity,
  validateRequest,
  verifyRegionalId,
  parseKycMessage,
  handleRegionalKycPrompt,
};
