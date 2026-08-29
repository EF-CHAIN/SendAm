const { sendSuccess, sendError } = require('../utils/response');
const {
  getOrCreateKycProfile,
  startKycVerification,
  processSmileIdCallback,
} = require('./compliance.service');
const { hashPin } = require('./pin.service');
const prisma = require('../common/prisma');
const { withIdAlias } = require('../common/records');
const { canonicalizePhoneNumber, isValidPhoneNumber } = require('../utils/validators');
const { writeAuditLog } = require('../common/audit.service');
const {
  validateTransition,
  requiresReason,
  assertConcurrency,
  makerCheckerRequired,
  buildReviewAuditMetadata,
  TransitionError,
} = require('./kyc.transitions');
const { getOnboardingStatus: computeOnboardingStatus } = require('./onboarding.service');
const logger = require('../utils/logger');

const getProfile = async (req, res, next) => {
  try {
    if (!isValidPhoneNumber(req.params.phone)) {
      return sendError(res, 'User not found', 404);
    }
    const phone = canonicalizePhoneNumber(req.params.phone);
    const user = await prisma.user.findUnique({ where: { phoneNumber: phone } });
    if (!user) return sendError(res, 'User not found', 404);
    const profile = await getOrCreateKycProfile(user);
    return sendSuccess(res, withIdAlias(profile));
  } catch (error) {
    next(error);
  }
};

const getOwnProfile = async (req, res, next) => {
  try {
    const profile = await getOrCreateKycProfile(req.restUser);
    return sendSuccess(res, withIdAlias(profile));
  } catch (error) { return next(error); }
};

const startKyc = async (req, res, next) => {
  try {
    const user = req.restUser;
    const profile = await startKycVerification({
      user,
      applicant: req.body,
    });
    return sendSuccess(res, withIdAlias(profile), 'KYC started', 202);
  } catch (error) {
    if (error.statusCode) return sendError(res, error.message, error.statusCode);
    next(error);
  }
};

const smileIdCallback = async (req, res, next) => {
  try {
    const result = await processSmileIdCallback(req.body);
    return sendSuccess(res, null, result.duplicate ? 'Callback already processed' : 'Callback processed');
  } catch (error) {
    // A signed but unmatched callback is acknowledged so provider retries do
    // not amplify an operator-recovery condition.
    if (error.statusCode === 202) return sendSuccess(res, null, error.message, 202);
    if (error.statusCode) return sendError(res, error.message, error.statusCode);
    next(error);
  }
};

/**
 * POST /kyc/:id/review
 *
 * Enforces:
 *   1. Transition matrix — only valid forward (or review-loop) transitions.
 *   2. Optimistic concurrency — updatedAt must match the client's snapshot.
 *   3. Structured reason — required when any field changes.
 *   4. Maker-checker — high-impact overrides create a pending approval
 *      record; a second operator must POST /kyc/:id/approve to finalise.
 *   5. Full audit — old/new state, reason, policy version, operator IDs.
 */
const reviewKyc = async (req, res, next) => {
  try {
    const profile = await prisma.kycProfile.findUnique({ where: { id: req.params.id } });
    if (!profile) return sendError(res, 'KYC profile not found', 404);

    // ── 1. Optimistic concurrency ───────────────────────────────────────
    try {
      assertConcurrency(req.body.updatedAt, profile.updatedAt);
    } catch (err) {
      if (err instanceof TransitionError) {
        return sendError(res, err.message, err.statusCode);
      }
      throw err;
    }

    // ── 2. Transition matrix + numeric bounds ────────────────────────────
    const { target, errors } = validateTransition(profile, req.body);
    if (errors.length > 0) {
      return sendError(res, errors.join('; '), 400);
    }

    // ── 3. Structured reason ────────────────────────────────────────────
    const changesRequested = requiresReason(profile, req.body);
    if (changesRequested && !req.body.reason) {
      return sendError(
        res,
        'A structured reason is required when changing KYC status, sanctions status, custody status, tier, or risk score.',
        400,
      );
    }

    // ── 4. Maker-checker ────────────────────────────────────────────────
    const mc = makerCheckerRequired(profile, req.body);
    if (mc.required) {
      // Create a pending approval record so a second operator can finalise.
      const pendingApproval = await prisma.kycApproval.create({
        data: {
          profileId: profile.id,
          proposedChanges: {
            ...target,
            reason: req.body.reason || null,
          },
          requestedBy: req.admin.id,
          status: 'pending',
        },
      });

      await writeAuditLog({
        actorType: 'administrator',
        actorId: req.admin.id,
        action: 'admin.compliance.override_submitted',
        entityType: 'KycProfile',
        entityId: profile.id,
        metadata: buildReviewAuditMetadata({
          profileBefore: profile,
          target,
          reason: req.body.reason,
          operator: req.admin,
          secondApprover: null,
        }),
        req,
      });

      return sendSuccess(
        res,
        {
          approvalId: pendingApproval.id,
          status: 'pending_approval',
          reason: mc.reason,
          proposedChanges: target,
        },
        'High-impact override requires second-operator approval',
        202,
      );
    }

    // ── 5. Apply the update ─────────────────────────────────────────────
    const reviewed = await prisma.kycProfile.update({
      where: { id: profile.id },
      data: {
        status: target.status,
        tier: target.tier,
        riskScore: target.riskScore,
        sanctionsStatus: target.sanctionsStatus,
        custodyStatus: target.custodyStatus,
        deniedReason: req.body.deniedReason ?? profile.deniedReason,
        sanctionsScreenedAt: target.sanctionsStatus !== 'not_screened' ? new Date() : profile.sanctionsScreenedAt,
        custodyReviewedAt: target.custodyStatus !== 'not_reviewed' ? new Date() : profile.custodyReviewedAt,
      },
    });

    await prisma.user.update({
      where: { id: reviewed.userId },
      data: { kycTier: reviewed.tier, riskScore: reviewed.riskScore },
    });

    await writeAuditLog({
      actorType: 'administrator',
      actorId: req.admin.id,
      action: 'admin.compliance.reviewed',
      entityType: 'KycProfile',
      entityId: reviewed.id,
      metadata: buildReviewAuditMetadata({
        profileBefore: profile,
        target,
        reason: req.body.reason,
        operator: req.admin,
        secondApprover: null,
      }),
      req,
    });

    return sendSuccess(res, withIdAlias(reviewed), 'KYC profile reviewed');
  } catch (error) {
    next(error);
  }
};

/**
 * POST /kyc/:id/approve
 *
 * Second-operator approval for high-impact overrides.
 * The approving operator must be different from the requester.
 */
const approveOverride = async (req, res, next) => {
  try {
    const approval = await prisma.kycApproval.findUnique({ where: { id: req.params.id } });
    if (!approval) return sendError(res, 'Approval record not found', 404);
    if (approval.status !== 'pending') {
      return sendError(res, `Approval already ${approval.status}`, 409);
    }

    // ── Same-operator guard ─────────────────────────────────────────────
    if (approval.requestedBy === req.admin.id) {
      return sendError(
        res,
        'Maker-checker requires a different operator to approve. You submitted this override and cannot approve it yourself.',
        403,
      );
    }

    const profile = await prisma.kycProfile.findUnique({ where: { id: approval.profileId } });
    if (!profile) return sendError(res, 'KYC profile not found', 404);

    const proposed = approval.proposedChanges;

    // Re-validate transition against current profile state (it may have
    // changed since the override was submitted).
    const { errors } = validateTransition(profile, proposed);
    if (errors.length > 0) {
      // Mark approval as superseded so stale requests don't linger.
      await prisma.kycApproval.update({
        where: { id: approval.id },
        data: { status: 'superseded' },
      });
      return sendError(res, `Profile state has changed since this override was submitted. ${errors.join('; ')}`, 409);
    }

    // ── Apply the approved changes ──────────────────────────────────────
    const reviewed = await prisma.kycProfile.update({
      where: { id: profile.id },
      data: {
        status: proposed.status,
        tier: proposed.tier,
        riskScore: proposed.riskScore,
        sanctionsStatus: proposed.sanctionsStatus,
        custodyStatus: proposed.custodyStatus,
        deniedReason: proposed.deniedReason ?? profile.deniedReason,
        sanctionsScreenedAt: proposed.sanctionsStatus !== 'not_screened' ? new Date() : profile.sanctionsScreenedAt,
        custodyReviewedAt: proposed.custodyStatus !== 'not_reviewed' ? new Date() : profile.custodyReviewedAt,
      },
    });

    await prisma.user.update({
      where: { id: reviewed.userId },
      data: { kycTier: reviewed.tier, riskScore: reviewed.riskScore },
    });

    // Mark approval as completed.
    await prisma.kycApproval.update({
      where: { id: approval.id },
      data: { status: 'approved', approvedBy: req.admin.id, decidedAt: new Date() },
    });

    // Fetch the original requester for the audit record.
    const originalOperator = await prisma.administrator.findUnique({
      where: { id: approval.requestedBy },
    }).catch(() => null);

    await writeAuditLog({
      actorType: 'administrator',
      actorId: req.admin.id,
      action: 'admin.compliance.override_approved',
      entityType: 'KycProfile',
      entityId: reviewed.id,
      metadata: buildReviewAuditMetadata({
        profileBefore: profile,
        target: proposed,
        reason: proposed.reason,
        operator: originalOperator || { id: approval.requestedBy, role: 'administrator' },
        secondApprover: req.admin,
      }),
      req,
    });

    return sendSuccess(res, withIdAlias(reviewed), 'Override approved and applied');
  } catch (error) {
    next(error);
  }
};

const setPin = async (req, res, next) => {
  try {
    const user = req.restUser;
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

/**
 * GET /compliance/onboarding
 * Customer self-service: returns their onboarding checkpoints, next step,
 * and any blockers. Linked to KYC, wallet, and account state (#330).
 */
const getOnboardingStatus = async (req, res, next) => {
  try {
    const user = req.restUser;
    const status = await computeOnboardingStatus(user.id);
    return sendSuccess(res, status);
  } catch (error) {
    if (error.statusCode) return sendError(res, error.message, error.statusCode);
    next(error);
  }
};

module.exports = {
  getProfile,
  getOwnProfile,
  startKyc,
  reviewKyc,
  approveOverride,
  setPin,
  smileIdCallback,
  getOnboardingStatus,
};
