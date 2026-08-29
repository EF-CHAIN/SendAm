const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const privacyController = require('../compliance/privacy.controller');
const reconciliationController = require('../payment/reconciliation.controller');
const supportController = require('../support/support.controller');
const requireAdmin = require('../middlewares/requireAdmin');
const { requirePermission } = require('../middlewares/requireAdmin');

// Tighter limiter on the credential endpoint to slow password brute-forcing,
// independent of the broader /api limiter.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many login attempts. Try again later.' },
});

router.post(
  '/login',
  loginLimiter,
  validateRequest({
    body: {
      allowedKeys: ['password'],
      required: ['password'],
      fields: {
        password: {
          type: 'string',
          trim: true,
          custom: (value) => value.length > 0,
          message: 'Password is required',
        },
      },
    },
  }),
  adminController.login,
);

// Everything below requires a valid admin token.
router.get('/stats', requireAdmin, requirePermission('stats:read'), adminController.getStats);
router.get('/users', requireAdmin, requirePermission('users:read'), adminController.getUsers);
router.get('/wallets', requireAdmin, requirePermission('wallets:read'), adminController.getWallets);
router.get('/transactions', requireAdmin, requirePermission('transactions:read'), adminController.getTransactions);
router.get('/kyc', requireAdmin, requirePermission('kyc:read'), adminController.getKycProfiles);
router.get('/audit-logs', requireAdmin, requirePermission('audit:read'), adminController.getAuditLogs);
router.get('/system-health', requireAdmin, requirePermission('system:read'), adminController.getSystemHealth);
router.post('/reveal/:resource/:id', requireAdmin, requirePermission('sensitive:reveal'), adminController.revealSensitiveFields);

// Reconciliation routes - deterministic transaction reconciliation
router.post('/reconciliation/trigger', requireAdmin('operations.write'), reconciliationController.triggerReconciliation);
router.get('/reconciliation/checkpoints', requireAdmin('operations.read'), reconciliationController.listReconciliationCheckpoints);
router.patch('/reconciliation/checkpoints/:checkpointId/resolve', requireAdmin('operations.write'), reconciliationController.resolveReconciliationMismatch);

// Support case routes - structured support workflow
router.post('/support/cases', requireAdmin('operations.write'), supportController.createSupportCase);
router.get('/support/cases', requireAdmin('operations.read'), supportController.listSupportCases);
router.get('/support/cases/:caseId', requireAdmin('operations.read'), supportController.getSupportCase);
router.post('/support/cases/:caseId/comments', requireAdmin('operations.write'), supportController.addCaseComment);
router.patch('/support/cases/:caseId', requireAdmin('operations.write'), supportController.updateSupportCase);

// ── Issue #318: Event ledger ─────────────────────────────────────────────────
// Query and verify the durable workflow event log.
router.get('/events', requireAdmin('admin.read'), adminController.getWorkflowEvents);
router.get('/events/verify', requireAdmin('admin.read'), adminController.verifyEventChain);
router.get('/events/export', requireAdmin('compliance.read'), adminController.exportWorkflowEvents);

// ── Issue #329: Compliance evidence exports ──────────────────────────────────
// Export structured compliance evidence packages and archives.
router.get('/compliance/evidence/:userId', requireAdmin('compliance.read'), adminController.getUserEvidencePackage);
router.get('/compliance/evidence/:userId/download', requireAdmin('compliance.read'), adminController.downloadUserEvidencePackage);
router.get('/compliance/kyc-evidence/export', requireAdmin('compliance.read'), adminController.exportKycEvidence);
router.get('/compliance/account-status/export', requireAdmin('compliance.read'), adminController.exportAccountStatusHistory);

// ── Issue #330: Onboarding status (admin view) ───────────────────────────────
router.get('/users/:userId/onboarding', requireAdmin('admin.read'), adminController.getUserOnboardingStatus);

// ── Issue #332: Account deactivation / reactivation ─────────────────────────
router.post('/users/:userId/deactivate', requireAdmin('operations.write'), adminController.deactivateUserAccount);
router.post('/users/:userId/reactivate', requireAdmin('operations.write'), adminController.reactivateUserAccount);
router.get('/users/:userId/account-status', requireAdmin('admin.read'), adminController.getUserAccountStatusHistory);

module.exports = router;
