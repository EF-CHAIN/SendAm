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
router.get('/stats', requireAdmin('admin.read'), adminController.getStats);
router.get('/users', requireAdmin('admin.read'), adminController.getUsers);
router.get('/wallets', requireAdmin('admin.read'), adminController.getWallets);
router.get('/transactions', requireAdmin('admin.read'), adminController.getTransactions);
router.post('/transactions/:id/refund', requireAdmin('operations.write'), adminController.refundTransaction);
router.get('/kyc', requireAdmin('compliance.read'), adminController.getKycProfiles);
router.get('/kyc/export', requireAdmin('compliance.read'), adminController.exportKyc);
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
router.get('/administrators', requireAdmin('*'), adminController.listAdministrators);
router.post('/administrators/invite', requireAdmin('*'), adminController.inviteAdministrator);
router.patch('/administrators/:id/role', requireAdmin('*'), adminController.updateAdministratorRole);
router.post('/administrators/:id/disable', requireAdmin('*'), adminController.disableAdministrator);
router.post('/administrators/:id/reset-credential', requireAdmin('*'), adminController.resetCredential);
router.post('/administrators/:id/revoke-sessions', requireAdmin('*'), adminController.revokeAdministratorSessions);

module.exports = router;
