const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const privacyController = require('../compliance/privacy.controller');
const requireAdmin = require('../middlewares/requireAdmin');

// Tighter limiter on the credential endpoint to slow password brute-forcing,
// independent of the broader /api limiter.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many login attempts. Try again later.' },
});

router.post('/login', loginLimiter, adminController.login);
router.post('/invitations/accept', loginLimiter, adminController.acceptInvite);
router.post('/logout', requireAdmin('admin.read'), adminController.logout);
// Identity of the authenticated operator. Needs an authenticated session but
// must be reachable even when a password change is pending.
router.get('/me', typeof requireAdmin.authenticate === 'function' ? requireAdmin.authenticate : requireAdmin('admin.read'), adminController.me);
// Self-serve password rotation. Explicitly exempt from the PASSWORD_CHANGE_REQUIRED
// gate so a bootstrap/temporary credential can be replaced with a private one.
router.post('/password', typeof requireAdmin.permission === 'function' ? requireAdmin.permission('*', { allowPasswordChangePending: true }) : requireAdmin('*'), adminController.changePassword);
router.post('/change-password', requireAdmin('admin.read'), adminController.changePassword);
router.get('/wallets/summary', requireAdmin('compliance.read'), adminController.getWalletSummary);
router.post('/wallets/:id/recover', requireAdmin('operations.write'), adminController.recoverWallet);
router.get('/security/rotation/status', requireAdmin('admin.read'), adminController.getSecretRotationStatus);
router.post('/security/rotation/rotate', requireAdmin('*'), adminController.rotateSecret);

router.get('/stats', requireAdmin('admin.read'), adminController.getStats);
router.get('/users', requireAdmin('admin.read'), adminController.getUsers);
router.get('/wallets', requireAdmin('admin.read'), adminController.getWallets);
router.get('/transactions', requireAdmin('admin.read'), adminController.getTransactions);
router.get('/transactions/:id', requireAdmin('admin.read'), adminController.getTransaction);
router.post('/transactions/:id/refund', requireAdmin('operations.write'), adminController.refundTransaction);
router.get('/payments/stuck', requireAdmin('operations.write'), adminController.getStuckPayments);
router.post('/payments/stuck/:id/retry', requireAdmin('operations.write'), adminController.retryStuckPayment);
router.post('/payments/stuck/:id/resolve', requireAdmin('operations.write'), adminController.markStuckPaymentResolved);
router.post('/payments/stuck/:id/escalate', requireAdmin('operations.write'), adminController.escalateStuckPayment);
router.get('/ledger/discrepancies', requireAdmin('operations.write'), adminController.getLedgerDiscrepancies);
router.get('/kyc', requireAdmin('compliance.read'), adminController.getKycProfiles);
router.get('/kyc/export', requireAdmin('compliance.read'), adminController.exportKyc);
router.get('/kyc/:id/expiry-status', requireAdmin('compliance.read'), adminController.getKycExpiryStatus);
router.get('/compliance/expiry-summary', requireAdmin('compliance.read'), adminController.getComplianceExpirySummary);
router.get('/audit-logs', requireAdmin('admin.read'), adminController.getAuditLogs);
router.get('/audit-logs/verify', requireAdmin('admin.read'), adminController.verifyAuditLogs);

// Customer privacy lifecycle (admin): review/approve erasure, retry provider
// deletion, and manage legal holds.
router.get('/privacy-requests', requireAdmin('compliance.read'), privacyController.listRequests);
router.get('/privacy-requests/:id', requireAdmin('compliance.read'), privacyController.getRequest);
router.post('/privacy-requests/:id/approve', requireAdmin('compliance.write'), privacyController.approveRequest);
router.post('/privacy-requests/:id/retry', requireAdmin('compliance.write'), privacyController.retryProviders);
router.get('/legal-holds', requireAdmin('compliance.read'), privacyController.listLegalHolds);
router.post('/legal-holds', requireAdmin('compliance.write'), privacyController.setLegalHold);
router.delete('/legal-holds/:userId', requireAdmin('compliance.write'), privacyController.releaseLegalHold);
router.get('/audit-logs/export', requireAdmin('admin.read'), adminController.exportAuditLogs);
router.get('/system-health', requireAdmin('operations.write'), adminController.getSystemHealth);

// ── Issue #228: Alert delivery test status ───────────────────────────────────
router.get('/alert-delivery-test', requireAdmin('operations.write'), adminController.getAlertDeliveryTestStatus);

// Dead-letter queue inspection and operator recovery (#340)
router.get('/dlq', requireAdmin('operations.write'), adminController.getDeadLetterJobs);
router.get('/dlq/:id', requireAdmin('operations.write'), adminController.getDeadLetterJobById);
router.post('/dlq/:id/replay', requireAdmin('operations.write'), adminController.replayDeadLetterJob);
router.delete('/dlq/:id', requireAdmin('operations.write'), adminController.discardDeadLetterJob);

router.get('/administrators', requireAdmin('*'), adminController.listAdministrators);
router.post('/administrators/invite', requireAdmin('*'), adminController.inviteAdministrator);
router.patch('/administrators/:id/role', requireAdmin('*'), adminController.updateAdministratorRole);
router.post('/administrators/:id/disable', requireAdmin('*'), adminController.disableAdministrator);
router.post('/administrators/:id/reset-credential', requireAdmin('*'), adminController.resetCredential);
router.post('/administrators/:id/revoke-sessions', requireAdmin('*'), adminController.revokeAdministratorSessions);

// Reveal sensitive fields (gated reveal of PII/secrets)
router.post('/reveal/:resource/:id', requireAdmin('sensitive:reveal'), adminController.revealSensitiveFields);

// ── Issue #318: Event ledger ─────────────────────────────────────────────────
router.get('/events', requireAdmin('admin.read'), adminController.getWorkflowEvents);
router.get('/events/verify', requireAdmin('admin.read'), adminController.verifyEventChain);
router.get('/events/export', requireAdmin('compliance.read'), adminController.exportWorkflowEvents);

// ── Issue #329: Compliance evidence exports ──────────────────────────────────
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

// ── Issue #308: Customer Statement generation (admin view) ────────────────────
router.get('/users/:userId/statement', requireAdmin('compliance.read'), adminController.getUserStatement);

module.exports = router;
