'use strict';

// Tier-1 BVN / NIN verification for Nigeria (#982).
//
// KYC_PROVIDER=dojah: synchronous Dojah lookup. The returned identity must
//   match the applicant's first name, last name and date of birth; a match
//   elevates the user to Tier 1 immediately, a mismatch or unknown ID is
//   rejected. Both outcomes are audit-logged.
// KYC_PROVIDER=smileid (default): delegates to the existing asynchronous Smile
//   ID job (compliance.service#startKycVerification); its signed callback
//   applies the decision.
//
// The raw BVN/NIN is never stored or logged: only an HMAC-SHA256 of it (keyed
// with KYC_ID_HASH_SECRET, so it can't be brute-forced from the 11-digit space
// without the key) and its last four digits. The hash also stops one BVN/NIN
// from verifying more than one SendAm account.

const crypto = require('crypto');
const prisma = require('../../common/prisma');
const config = require('../../config/env');
const logger = require('../../utils/logger');
const { writeAuditLog } = require('../../common/audit.service');
const { getOrCreateKycProfile, startKycVerification } = require('../compliance.service');
const { syncKycAndRiskState, KYC_STATUSES } = require('../kycDecision.service');
const dojah = require('./dojah');

const ID_TYPES = Object.freeze(['BVN', 'NIN']);
const MAX_ATTEMPTS_PER_DAY = 5;

const kycError = (message, statusCode, code) => Object.assign(new Error(message), { statusCode, code });

const hashIdNumber = (idType, idNumber, secret = config.compliance.kycIdHashSecret) => {
  if (!secret) throw kycError('KYC identity hashing is not configured.', 503, 'KYC_HASH_SECRET_MISSING');
  return crypto.createHmac('sha256', secret).update(`${idType}:${idNumber}`, 'utf8').digest('hex');
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
 * First and last name must both appear among the record's names (order-
 * insensitive, since NIN/BVN records often swap them), and DOB must match.
 */
const matchIdentity = (applicant, record) => {
  const recordNames = new Set([record.firstName, record.middleName, record.lastName].map(normalizeName).filter(Boolean));
  const firstName = recordNames.has(normalizeName(applicant.firstName));
  const lastName = recordNames.has(normalizeName(applicant.lastName));
  const applicantDob = normalizeDob(applicant.dob);
  const dob = Boolean(applicantDob) && applicantDob === normalizeDob(record.dob);
  return { matched: firstName && lastName && dob, firstName, lastName, dob };
};

const validateRequest = ({ idType, idNumber, firstName, lastName, dob }) => {
  const type = String(idType || '').toUpperCase();
  if (!ID_TYPES.includes(type)) throw kycError('idType must be BVN or NIN.', 400, 'KYC_INVALID_ID_TYPE');
  const number = String(idNumber || '').replace(/\s/g, '');
  if (!/^\d{11}$/.test(number)) throw kycError(`${type} must be 11 digits.`, 400, 'KYC_INVALID_ID_NUMBER');
  if (!String(firstName || '').trim() || !String(lastName || '').trim()) {
    throw kycError('First and last name are required.', 400, 'KYC_NAME_REQUIRED');
  }
  if (!normalizeDob(dob)) throw kycError('Date of birth must be a valid date (YYYY-MM-DD).', 400, 'KYC_INVALID_DOB');
  return { idType: type, idNumber: number };
};

const audit = (action, user, metadata) => writeAuditLog({
  actorType: 'user',
  actorId: String(user.id),
  action,
  entityType: 'User',
  entityId: String(user.id),
  metadata,
});

const recordAttempt = (data) => prisma.kycVerification.create({ data });

/**
 * @returns {Promise<{status: 'verified'|'rejected'|'pending'|'already_verified', tier: number, reason?: string}>}
 */
const verifyBvnNin = async ({ user, idType: rawType, idNumber: rawNumber, firstName, lastName, dob }, deps = {}) => {
  const { idType, idNumber } = validateRequest({ idType: rawType, idNumber: rawNumber, firstName, lastName, dob });
  const idHash = hashIdNumber(idType, idNumber, deps.hashSecret);
  const idLast4 = idNumber.slice(-4);
  const profile = await getOrCreateKycProfile(user);

  if (profile.status === KYC_STATUSES.APPROVED && profile.tier >= 1) {
    return { status: 'already_verified', tier: profile.tier };
  }

  const provider = config.compliance.provider;
  if (provider !== 'dojah') {
    // Smile ID: asynchronous job; the existing signed callback decides.
    const pending = await startKycVerification({
      user,
      applicant: { country: 'NG', idType, idNumber, firstName, lastName, dob: normalizeDob(dob) },
    });
    await recordAttempt({
      userId: user.id, provider: 'smileid', idType, idHash, idLast4,
      status: 'pending', providerReference: pending?.providerReference || null,
    });
    return { status: 'pending', tier: profile.tier };
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const attempts = await prisma.kycVerification.count({ where: { userId: user.id, createdAt: { gte: since } } });
  if (attempts >= MAX_ATTEMPTS_PER_DAY) {
    throw kycError('Too many verification attempts. Please try again tomorrow.', 429, 'KYC_TOO_MANY_ATTEMPTS');
  }

  const linkedElsewhere = await prisma.kycVerification.findFirst({
    where: { idHash, status: 'verified', userId: { not: user.id } },
    select: { id: true },
  });
  if (linkedElsewhere) {
    await recordAttempt({ userId: user.id, provider, idType, idHash, idLast4, status: 'rejected', failureReason: 'id_linked_to_another_account' });
    await audit('kyc.verification.rejected', user, { provider, idType, idLast4, reason: 'id_linked_to_another_account' });
    return { status: 'rejected', tier: profile.tier, reason: 'id_linked_to_another_account' };
  }

  let record;
  try {
    record = await dojah.lookupIdentity({ idType, idNumber }, { httpGet: deps.httpGet });
  } catch (error) {
    if (error instanceof dojah.IdentityNotFoundError) {
      await recordAttempt({ userId: user.id, provider, idType, idHash, idLast4, status: 'rejected', failureReason: 'id_not_found' });
      await audit('kyc.verification.rejected', user, { provider, idType, idLast4, reason: 'id_not_found' });
      return { status: 'rejected', tier: profile.tier, reason: 'id_not_found' };
    }
    // Provider/transport failure: retryable, not a rejection of the user.
    logger.error('kyc_bvn_nin_lookup_failed', { userId: user.id, idType, message: error.message });
    throw kycError('Identity verification is temporarily unavailable. Please try again shortly.', error.statusCode === 503 ? 503 : 502, 'KYC_PROVIDER_UNAVAILABLE');
  }

  const match = matchIdentity({ firstName, lastName, dob }, record);
  const matchSummary = { firstName: match.firstName, lastName: match.lastName, dob: match.dob };

  if (!match.matched) {
    await recordAttempt({
      userId: user.id, provider, idType, idHash, idLast4, status: 'rejected',
      providerReference: record.reference, failureReason: 'details_mismatch', metadata: { match: matchSummary },
    });
    await audit('kyc.verification.rejected', user, { provider, idType, idLast4, reason: 'details_mismatch', match: matchSummary });
    return { status: 'rejected', tier: profile.tier, reason: 'details_mismatch' };
  }

  await recordAttempt({
    userId: user.id, provider, idType, idHash, idLast4, status: 'verified',
    providerReference: record.reference, verifiedAt: new Date(), metadata: { match: matchSummary },
  });
  const tier = Math.max(1, profile.tier || 0);
  await syncKycAndRiskState({
    userId: user.id,
    tier,
    status: KYC_STATUSES.APPROVED,
    deniedReason: null,
    metadata: { ...(profile.metadata || {}), tier1Verification: { provider, idType, idLast4, verifiedAt: new Date().toISOString() } },
    actorType: 'provider',
    actorId: provider,
  });
  await audit('kyc.verification.approved', user, { provider, idType, idLast4, tier });
  logger.info('kyc_bvn_nin_verified', { userId: user.id, idType, provider });
  return { status: 'verified', tier };
};

module.exports = {
  ID_TYPES,
  MAX_ATTEMPTS_PER_DAY,
  hashIdNumber,
  normalizeName,
  normalizeDob,
  matchIdentity,
  verifyBvnNin,
};
