'use strict';

/**
 * KYC Transition Matrix
 * ----------------------
 * Every admin review of a KycProfile must satisfy:
 *   1. Target status values are on the allowlist.
 *   2. The transition from the current status to the target status is in the
 *      allowed set below (forward-only unless explicitly listed).
 *   3. Tier and risk-score values are within bounded ranges.
 *   4. High-impact overrides require a second approver (maker-checker).
 *   5. Optimistic-concurrency is enforced via the updatedAt timestamp.
 *
 * Policy version is stamped on every audit record so that future policy
 * changes are distinguishable retroactively.
 */

const POLICY_VERSION = '2026-08-28';

// ── Allowlists (same values as before, but centrally owned) ──────────────

const VALID_KYC_STATUSES = ['not_started', 'pending', 'approved', 'rejected', 'review'];
const VALID_SANCTIONS_STATUSES = ['not_screened', 'cleared', 'review', 'blocked'];
const VALID_CUSTODY_STATUSES = ['not_reviewed', 'approved', 'review', 'denied'];

// ── Transition matrix ────────────────────────────────────────────────────
// Keys are current status; values are the statuses that may follow.

const KYC_STATUS_TRANSITIONS = {
  not_started: ['pending'],
  pending:     ['approved', 'rejected', 'review'],
  review:      ['approved', 'rejected', 'pending'],
  approved:    ['review'],
  rejected:    ['review'],
};

const SANCTIONS_STATUS_TRANSITIONS = {
  not_screened: ['cleared', 'review', 'blocked'],
  review:       ['cleared', 'blocked'],
  cleared:      ['review'],
  blocked:      ['review'],
};

const CUSTODY_STATUS_TRANSITIONS = {
  not_reviewed: ['approved', 'review', 'denied'],
  review:       ['approved', 'denied'],
  approved:     ['review'],
  denied:       ['review'],
};

// ── Tier / risk-score bounds ────────────────────────────────────────────

const TIER_MIN = 0;
const TIER_MAX = 3;
const RISK_SCORE_MIN = 0;
const RISK_SCORE_MAX = 100;

// Maximum allowed single-step tier change.  Moving more than one tier in a
// single review is treated as a high-impact override requiring maker-checker.
const TIER_STEP_LIMIT = 1;

// ── High-impact override rules ──────────────────────────────────────────
// An override is "high-impact" if ANY of the following are true:
//   • KYC status moves backward (approved/rejected → anything that isn't the
//     forward path through review).
//   • Sanctions status moves from 'blocked' to anything other than 'review'.
//   • Custody status moves from 'denied' to anything other than 'review'.
//   • Tier changes by more than TIER_STEP_LIMIT.
//   • Risk-score changes by more than RISK_SCORE_MAX (i.e. always requires
//     structured reason; the threshold below is for the *override* flag).
const RISK_SCORE_OVERRIDE_THRESHOLD = 30;

const isBackwardKycTransition = (from, to) => {
  if (from === to) return false; // no change is not backward
  const allowed = KYC_STATUS_TRANSITIONS[from];
  if (!allowed) return true; // unknown status treated as blocked
  return !allowed.includes(to);
};

const isHighImpactOverride = ({ from, to, tierDelta, riskScoreDelta }) => {
  if (isBackwardKycTransition(from.kycStatus, to.kycStatus)) return true;
  if (from.sanctionsStatus === 'blocked' && to.sanctionsStatus !== 'review') return true;
  if (from.custodyStatus === 'denied' && to.custodyStatus !== 'review') return true;
  if (Math.abs(tierDelta) > TIER_STEP_LIMIT) return true;
  if (Math.abs(riskScoreDelta) > RISK_SCORE_OVERRIDE_THRESHOLD) return true;
  return false;
};

// ── Validation helpers ──────────────────────────────────────────────────

class TransitionError extends Error {
  constructor(code, message, details, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

/**
 * Validate that the requested status values are on their allowlists and that
 * transitions from the current profile state are permitted by the matrix.
 *
 * @param {object} current   The current KycProfile row (as fetched from DB).
 * @param {object} requested The fields the admin wants to set.
 * @returns {{ target: object, errors: string[] }}
 */
function validateTransition(current, requested) {
  const errors = [];

  const targetStatus = requested.status ?? current.status;
  const targetSanctions = requested.sanctionsStatus ?? current.sanctionsStatus;
  const targetCustody = requested.custodyStatus ?? current.custodyStatus;
  const targetTier = requested.tier !== undefined ? Number(requested.tier) : current.tier;
  const targetRisk = requested.riskScore !== undefined ? Number(requested.riskScore) : current.riskScore;

  // ── Allowlist checks ──────────────────────────────────────────────────
  if (!VALID_KYC_STATUSES.includes(targetStatus)) {
    errors.push(`Invalid KYC status "${targetStatus}". Allowed: ${VALID_KYC_STATUSES.join(', ')}`);
  }
  if (!VALID_SANCTIONS_STATUSES.includes(targetSanctions)) {
    errors.push(`Invalid sanctions status "${targetSanctions}". Allowed: ${VALID_SANCTIONS_STATUSES.join(', ')}`);
  }
  if (!VALID_CUSTODY_STATUSES.includes(targetCustody)) {
    errors.push(`Invalid custody status "${targetCustody}". Allowed: ${VALID_CUSTODY_STATUSES.join(', ')}`);
  }

  // ── Transition matrix checks ──────────────────────────────────────────
  if (targetStatus !== current.status) {
    const allowed = KYC_STATUS_TRANSITIONS[current.status];
    if (!allowed || !allowed.includes(targetStatus)) {
      errors.push(
        `Invalid KYC transition: ${current.status} → ${targetStatus}. ` +
        `Allowed: ${allowed ? allowed.join(', ') : '(none)'}`,
      );
    }
  }
  if (targetSanctions !== current.sanctionsStatus) {
    const allowed = SANCTIONS_STATUS_TRANSITIONS[current.sanctionsStatus];
    if (!allowed || !allowed.includes(targetSanctions)) {
      errors.push(
        `Invalid sanctions transition: ${current.sanctionsStatus} → ${targetSanctions}. ` +
        `Allowed: ${allowed ? allowed.join(', ') : '(none)'}`,
      );
    }
  }
  if (targetCustody !== current.custodyStatus) {
    const allowed = CUSTODY_STATUS_TRANSITIONS[current.custodyStatus];
    if (!allowed || !allowed.includes(targetCustody)) {
      errors.push(
        `Invalid custody transition: ${current.custodyStatus} → ${targetCustody}. ` +
        `Allowed: ${allowed ? allowed.join(', ') : '(none)'}`,
      );
    }
  }

  // ── Numeric bounds ────────────────────────────────────────────────────
  if (!Number.isInteger(targetTier) || targetTier < TIER_MIN || targetTier > TIER_MAX) {
    errors.push(`Tier must be an integer between ${TIER_MIN} and ${TIER_MAX}. Got ${targetTier}.`);
  }
  if (!Number.isInteger(targetRisk) || targetRisk < RISK_SCORE_MIN || targetRisk > RISK_SCORE_MAX) {
    errors.push(`Risk score must be an integer between ${RISK_SCORE_MIN} and ${RISK_SCORE_MAX}. Got ${targetRisk}.`);
  }

  const target = {
    status: targetStatus,
    sanctionsStatus: targetSanctions,
    custodyStatus: targetCustody,
    tier: targetTier,
    riskScore: targetRisk,
  };

  return { target, errors };
}

/**
 * Determine whether a structured reason is required for this review.
 * Reasons are required when any field changes from the current profile state.
 */
function requiresReason(current, requested) {
  const targetStatus = requested.status ?? current.status;
  const targetSanctions = requested.sanctionsStatus ?? current.sanctionsStatus;
  const targetCustody = requested.custodyStatus ?? current.custodyStatus;
  const targetTier = requested.tier !== undefined ? Number(requested.tier) : current.tier;
  const targetRisk = requested.riskScore !== undefined ? Number(requested.riskScore) : current.riskScore;

  return (
    targetStatus !== current.status ||
    targetSanctions !== current.sanctionsStatus ||
    targetCustody !== current.custodyStatus ||
    targetTier !== current.tier ||
    targetRisk !== current.riskScore
  );
}

/**
 * Optimistic concurrency guard.
 * Throws a 409 Conflict if the profile has been modified since the client
 * last read it.  `expectedUpdatedAt` should be the ISO string the client
 * received; `actualUpdatedAt` is the value currently in the database.
 */
function assertConcurrency(expectedUpdatedAt, actualUpdatedAt) {
  if (!expectedUpdatedAt) {
    throw new TransitionError('CONCURRENCY_REQUIRED', 'updatedAt is required for optimistic concurrency. Include the profile\'s updatedAt in the request body.', undefined, 400);
  }
  const expected = new Date(expectedUpdatedAt).getTime();
  const actual = new Date(actualUpdatedAt).getTime();
  if (expected !== actual) {
    throw new TransitionError(
      'STALE_PROFILE',
      `Profile was modified by another operator since this review was opened. ` +
      `Expected updatedAt ${expectedUpdatedAt}, found ${actualUpdatedAt}. ` +
      `Please reload the profile and resubmit.`,
      { expectedUpdatedAt, actualUpdatedAt },
      409,
    );
  }
}

/**
 * Determine whether the change requires maker-checker (two-operator) approval.
 * Returns { required: boolean, reason: string }.
 */
function makerCheckerRequired(current, requested) {
  const targetStatus = requested.status ?? current.status;
  const targetSanctions = requested.sanctionsStatus ?? current.sanctionsStatus;
  const targetCustody = requested.custodyStatus ?? current.custodyStatus;
  const targetTier = requested.tier !== undefined ? Number(requested.tier) : current.tier;
  const targetRisk = requested.riskScore !== undefined ? Number(requested.riskScore) : current.riskScore;

  const tierDelta = targetTier - current.tier;
  const riskDelta = targetRisk - current.riskScore;

  const highImpact = isHighImpactOverride({
    from: { kycStatus: current.status, sanctionsStatus: current.sanctionsStatus, custodyStatus: current.custodyStatus },
    to: { kycStatus: targetStatus, sanctionsStatus: targetSanctions, custodyStatus: targetCustody },
    tierDelta,
    riskScoreDelta: riskDelta,
  });

  if (!highImpact) return { required: false, reason: null };

  const reasons = [];
  if (isBackwardKycTransition(current.status, targetStatus)) {
    reasons.push(`backward KYC status change (${current.status} → ${targetStatus})`);
  }
  if (current.sanctionsStatus === 'blocked' && targetSanctions !== 'review') {
    reasons.push('unblocking sanctions-blocked profile');
  }
  if (current.custodyStatus === 'denied' && targetCustody !== 'review') {
    reasons.push('reversing custody denial');
  }
  if (Math.abs(tierDelta) > TIER_STEP_LIMIT) {
    reasons.push(`tier change of ${tierDelta > 0 ? '+' : ''}${tierDelta}`);
  }
  if (Math.abs(riskDelta) > RISK_SCORE_OVERRIDE_THRESHOLD) {
    reasons.push(`risk score change of ${riskDelta > 0 ? '+' : ''}${riskDelta}`);
  }

  return { required: true, reason: reasons.join('; ') };
}

/**
 * Build the audit metadata for a KYC review decision.  Includes old/new
 * state, reason, policy version, and operator identities.
 */
function buildReviewAuditMetadata({ profileBefore, target, reason, operator, secondApprover }) {
  return {
    oldState: {
      status: profileBefore.status,
      tier: profileBefore.tier,
      riskScore: profileBefore.riskScore,
      sanctionsStatus: profileBefore.sanctionsStatus,
      custodyStatus: profileBefore.custodyStatus,
    },
    newState: {
      status: target.status,
      tier: target.tier,
      riskScore: target.riskScore,
      sanctionsStatus: target.sanctionsStatus,
      custodyStatus: target.custodyStatus,
    },
    reason: reason || null,
    policyVersion: POLICY_VERSION,
    operator: { id: operator.id, role: operator.role || 'administrator' },
    secondApprover: secondApprover ? { id: secondApprover.id, role: secondApprover.role || 'administrator' } : null,
  };
}

module.exports = {
  POLICY_VERSION,
  VALID_KYC_STATUSES,
  VALID_SANCTIONS_STATUSES,
  VALID_CUSTODY_STATUSES,
  KYC_STATUS_TRANSITIONS,
  SANCTIONS_STATUS_TRANSITIONS,
  CUSTODY_STATUS_TRANSITIONS,
  TIER_MIN,
  TIER_MAX,
  RISK_SCORE_MIN,
  RISK_SCORE_MAX,
  TIER_STEP_LIMIT,
  RISK_SCORE_OVERRIDE_THRESHOLD,
  TransitionError,
  validateTransition,
  requiresReason,
  assertConcurrency,
  makerCheckerRequired,
  isHighImpactOverride,
  buildReviewAuditMetadata,
};
