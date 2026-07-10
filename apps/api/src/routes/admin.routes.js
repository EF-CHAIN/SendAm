const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const requireAdmin = require('../middlewares/requireAdmin');

// Tighter limiter on the credential endpoint to slow password brute-forcing,
// independent of the broader /api limiter.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many login attempts. Try again later.' },
});

router.post('/login', loginLimiter, adminController.login);

// Everything below requires a valid admin token.
router.get('/stats', requireAdmin, adminController.getStats);
router.get('/users', requireAdmin, adminController.getUsers);
router.get('/wallets', requireAdmin, adminController.getWallets);
router.get('/transactions', requireAdmin, adminController.getTransactions);
router.get('/escrows', requireAdmin, adminController.getEscrows);
router.get('/kyc', requireAdmin, adminController.getKycProfiles);
router.get('/audit-logs', requireAdmin, adminController.getAuditLogs);
router.get('/system-health', requireAdmin, adminController.getSystemHealth);

module.exports = router;
