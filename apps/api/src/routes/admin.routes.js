const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const requireAdmin = require('../middlewares/requireAdmin');
const { validateRequest } = require('../middlewares/validateRequest');

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
router.get(
  '/stats',
  requireAdmin,
  validateRequest({
    query: {
      allowedKeys: [],
      fields: {},
    },
  }),
  adminController.getStats,
);
router.get(
  '/users',
  requireAdmin,
  validateRequest({
    query: {
      allowedKeys: ['page', 'limit'],
      fields: {
        page: { type: 'string', optional: true },
        limit: { type: 'string', optional: true },
      },
    },
  }),
  adminController.getUsers,
);
router.get(
  '/wallets',
  requireAdmin,
  validateRequest({
    query: {
      allowedKeys: ['page', 'limit'],
      fields: {
        page: { type: 'string', optional: true },
        limit: { type: 'string', optional: true },
      },
    },
  }),
  adminController.getWallets,
);
router.get(
  '/transactions',
  requireAdmin,
  validateRequest({
    query: {
      allowedKeys: ['page', 'limit'],
      fields: {
        page: { type: 'string', optional: true },
        limit: { type: 'string', optional: true },
      },
    },
  }),
  adminController.getTransactions,
);
router.get('/kyc', requireAdmin, adminController.getKycProfiles);
router.get('/audit-logs', requireAdmin, adminController.getAuditLogs);
router.get('/system-health', requireAdmin, adminController.getSystemHealth);

module.exports = router;
