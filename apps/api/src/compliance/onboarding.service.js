'use strict';

/**
 * Onboarding Status Service (#330)
 * ──────────────────────────────────
 * Computes a customer's onboarding progress from their live backend state:
 * wallet readiness, KYC tier, PIN setup, and account health.
 *
 * Returns a structured status object that:
 *   - Lists completed checkpoints and the next required action.
 *   - Identifies blockers (deactivation, sanctions, rejected KYC, etc.).
 *   - Is synchronised directly from KycProfile, Wallet, and User state
 *     so the frontend only needs to call this endpoint; no denormalised
 *     status table is required.
 *
 * Used by:
 *   GET /api/compliance/onboarding   — customer self-service (REST session)
 *   GET /api/admin/users/:id/onboarding — admin view
 */

const prisma = require('../common/prisma');

// ── Checkpoint definitions ──────────────────────────────────────────────

/**
 * @typedef {object} Checkpoint
 * @property {string}  id          — Stable identifier.
 * @property {string}  label       — Human-readable title.
 * @property {string}  description — What completing this checkpoint means.
 * @property {boolean} complete    — Whether the checkpoint is satisfied.
 * @property {string}  [blocker]   — Why this checkpoint is blocked (if any).
 */

const CHECKPOINT_IDS = Object.freeze({
  ACCOUNT_CREATED:  'account_created',
  WALLET_READY:     'wallet_ready',
  PIN_SET:          'pin_set',
  KYC_STARTED:      'kyc_started',
  KYC_APPROVED:     'kyc_approved',
  ACCOUNT_ACTIVE:   'account_active',
});

// ── Onboarding stages (ordered) ─────────────────────────────────────────

const STAGES = ['not_started', 'in_progress', 'blocked', 'complete'];

/**
 * Resolve the overall onboarding stage from checkpoint state.
 */
const resolveStage = (checkpoints, blockers) => {
  if (blockers.length > 0) return 'blocked';
  const total = checkpoints.length;
  const done = checkpoints.filter((c) => c.complete).length;
  if (done === 0) return 'not_started';
  if (done === total) return 'complete';
  return 'in_progress';
};

// ── Next-step resolver ──────────────────────────────────────────────────

/**
 * Return the first incomplete checkpoint that the customer can act on,
 * plus a human-readable instruction.
 */
const resolveNextStep = (checkpoints, blockers) => {
  if (blockers.length > 0) {
    return { action: 'contact_support', message: blockers[0] };
  }

  const next = checkpoints.find((c) => !c.complete);
  if (!next) return { action: 'none', message: 'Your account is fully set up.' };

  const MESSAGES = {
    [CHECKPOINT_IDS.WALLET_READY]:   { action: 'wait', message: 'Your wallet is being set up. This usually takes a few seconds.' },
    [CHECKPOINT_IDS.PIN_SET]:        { action: 'set_pin', message: 'Set a 4-digit PIN to secure your payments.' },
    [CHECKPOINT_IDS.KYC_STARTED]:    { action: 'start_kyc', message: 'Verify your identity to unlock higher payment limits.' },
    [CHECKPOINT_IDS.KYC_APPROVED]:   { action: 'await_review', message: 'Your identity verification is under review. We\'ll notify you when it\'s approved.' },
    [CHECKPOINT_IDS.ACCOUNT_ACTIVE]: { action: 'contact_support', message: 'Your account requires attention. Please contact support.' },
  };

  return MESSAGES[next.id] || { action: 'unknown', message: 'Complete the next step to continue.' };
};

// ── Core: compute onboarding status ────────────────────────────────────

/**
 * Compute the onboarding status for a user.
 *
 * @param {string} userId — The user's ID.
 * @returns {Promise<OnboardingStatus>}
 */
const getOnboardingStatus = async (userId) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      kycProfile: true,
      wallets: {
        where: { chain: 'stellar' },
        orderBy: { createdAt: 'asc' },
        take: 1,
      },
    },
  });

  if (!user) {
    throw Object.assign(new Error('User not found'), { statusCode: 404 });
  }

  const wallet = user.wallets[0] || null;
  const kyc = user.kycProfile;

  // ── Blocker detection ───────────────────────────────────────────────
  const blockers = [];

  if (user.deactivatedAt) {
    blockers.push('Your account has been deactivated. Contact support to restore access.');
  }

  if (kyc?.sanctionsStatus === 'blocked') {
    blockers.push('Your account is under a compliance hold. Contact support for assistance.');
  }

  if (kyc?.status === 'rejected') {
    blockers.push('Your identity verification was not approved. Contact support to appeal or re-verify.');
  }

  // ── Checkpoint evaluation ───────────────────────────────────────────
  const walletReady = wallet
    ? wallet.funded && wallet.fundingState === 'succeeded' && wallet.trustlineState === 'succeeded'
    : false;

  const walletBlocker = wallet
    ? (wallet.fundingState === 'failed' ? 'Wallet funding failed. Please retry or contact support.' : null)
    : null;

  const kycStarted = kyc && kyc.status !== 'not_started';
  const kycApproved = kyc?.status === 'approved' || (user.kycTier || 0) >= 1;

  const checkpoints = [
    {
      id: CHECKPOINT_IDS.ACCOUNT_CREATED,
      label: 'Account created',
      description: 'Your WhatsApp account is registered.',
      complete: true,
    },
    {
      id: CHECKPOINT_IDS.WALLET_READY,
      label: 'Wallet ready',
      description: 'Your Stellar wallet has been funded and is ready to send and receive.',
      complete: walletReady,
      blocker: walletBlocker,
    },
    {
      id: CHECKPOINT_IDS.PIN_SET,
      label: 'PIN set',
      description: 'A 4-digit PIN protects your payment confirmations.',
      complete: Boolean(user.pinHash),
    },
    {
      id: CHECKPOINT_IDS.KYC_STARTED,
      label: 'Identity verification started',
      description: 'You have initiated the identity verification process.',
      complete: kycStarted,
    },
    {
      id: CHECKPOINT_IDS.KYC_APPROVED,
      label: 'Identity verified',
      description: 'Your identity has been verified and your payment limits have been upgraded.',
      complete: kycApproved,
    },
    {
      id: CHECKPOINT_IDS.ACCOUNT_ACTIVE,
      label: 'Account in good standing',
      description: 'Your account has no compliance or security holds.',
      complete: blockers.length === 0,
      blocker: blockers.length > 0 ? blockers[0] : null,
    },
  ];

  const stage = resolveStage(checkpoints, blockers);
  const nextStep = resolveNextStep(checkpoints, blockers);
  const completedCount = checkpoints.filter((c) => c.complete).length;
  const percentComplete = Math.round((completedCount / checkpoints.length) * 100);

  // ── KYC summary ────────────────────────────────────────────────────
  const kycSummary = {
    status: kyc?.status || 'not_started',
    tier: user.kycTier || 0,
    sanctionsStatus: kyc?.sanctionsStatus || 'not_screened',
    providerReference: kyc?.providerReference || null,
  };

  // ── Wallet summary ─────────────────────────────────────────────────
  const walletSummary = wallet
    ? {
        publicKey: wallet.publicKey,
        funded: wallet.funded,
        fundingState: wallet.fundingState,
        trustlineState: wallet.trustlineState,
        network: wallet.network,
      }
    : null;

  return {
    userId,
    stage,
    percentComplete,
    checkpoints,
    nextStep,
    blockers,
    kyc: kycSummary,
    wallet: walletSummary,
    accountActive: !user.deactivatedAt,
    deactivatedAt: user.deactivatedAt || null,
    deactivationReason: user.deactivationReason || null,
    computedAt: new Date().toISOString(),
  };
};

module.exports = {
  CHECKPOINT_IDS,
  STAGES,
  getOnboardingStatus,
};
