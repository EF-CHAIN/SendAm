const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const requireAdmin = require('../middlewares/requireAdmin');
const { requirePermission } = require('../middlewares/requireAdmin');

// Tighter limiter on the credential endpoint to slow password brute-forcing,
// independent of the broader /api limiter.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many login attempts. Try again later.' },
});

router.post('/login', loginLimiter, adminController.login);

// Everything below requires a valid admin token.
router.get('/stats', requireAdmin, requirePermission('stats:read'), adminController.getStats);
router.get('/users', requireAdmin, requirePermission('users:read'), adminController.getUsers);
router.get('/wallets', requireAdmin, requirePermission('wallets:read'), adminController.getWallets);
router.get('/transactions', requireAdmin, requirePermission('transactions:read'), adminController.getTransactions);
router.get('/kyc', requireAdmin, requirePermission('kyc:read'), adminController.getKycProfiles);
router.get('/audit-logs', requireAdmin, requirePermission('audit:read'), adminController.getAuditLogs);
router.get('/system-health', requireAdmin, requirePermission('system:read'), adminController.getSystemHealth);
router.post('/reveal/:resource/:id', requireAdmin, requirePermission('sensitive:reveal'), adminController.revealSensitiveFields);

module.exports = router;
