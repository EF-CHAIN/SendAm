const express = require('express');
const router = express.Router();
const controller = require('./compliance.controller');
const privacyController = require('./privacy.controller');
const consentController = require('./consent.controller');
const requireAdmin = require('../middlewares/requireAdmin');
const requireRestApiEnabled = require('../middlewares/requireRestApiEnabled');
const requireRestSession = require('../middlewares/requireRestSession');
const { validateRequest } = require('../middlewares/validateRequest');

// Admin single-user lookup
router.get(
  '/kyc/:phone',
  requireAdmin,
  validateRequest({
    params: {
      allowedKeys: ['phone'],
      required: ['phone'],
      fields: {
        phone: {
          type: 'string',
          trim: true,
          custom: (value) => value.length > 5,
          message: 'A valid phone number is required',
        },
      },
    },
  }),
  controller.getProfile,
);

// Customer self-service KYC profile
router.get('/kyc', requireRestApiEnabled, requireRestSession, controller.getOwnProfile);

// Customer start KYC verification
router.post(
  '/kyc/start',
  requireRestApiEnabled,
  requireRestSession,
  controller.startKyc,
);

// Customer Tier-1 BVN/NIN verification (#982)
router.post(
  '/kyc/bvn-nin',
  requireRestApiEnabled,
  requireRestSession,
  validateRequest({
    body: {
      allowedKeys: ['idType', 'idNumber', 'firstName', 'lastName', 'dob'],
      required: ['idType', 'idNumber', 'firstName', 'lastName', 'dob'],
      fields: {
        idType: { type: 'string', trim: true, custom: (value) => /^(BVN|NIN)$/i.test(value), message: 'idType must be BVN or NIN' },
        idNumber: { type: 'string', trim: true, custom: (value) => /^\d{11}$/.test(value), message: 'idNumber must be 11 digits' },
        firstName: { type: 'string', trim: true, custom: (value) => value.length > 0 && value.length <= 100, message: 'firstName is required' },
        lastName: { type: 'string', trim: true, custom: (value) => value.length > 0 && value.length <= 100, message: 'lastName is required' },
        dob: { type: 'string', trim: true, custom: (value) => value.length <= 20, message: 'dob is required' },
      },
    },
  }),
  controller.verifyBvnNin,
);

// Provider callback for Smile ID
router.post('/kyc/callback/smileid', controller.smileIdCallback);

// Customer PIN setup
router.post(
  '/pin',
  requireRestApiEnabled,
  requireRestSession,
  validateRequest({
    body: {
      allowedKeys: ['phoneNumber', 'pin'],
      required: ['pin'],
      fields: {
        pin: {
          type: 'string',
          trim: true,
          custom: (value) => /^\d{4,6}$/.test(value),
          message: 'A 4-6 digit numeric PIN is required',
        },
        phoneNumber: { type: 'string', optional: true },
      },
    },
  }),
  controller.setPin,
);

// Customer onboarding status (#330)
router.get('/onboarding', requireRestApiEnabled, requireRestSession, controller.getOnboardingStatus);

// ── Messaging preferences (#310) ────────────────────────────────────────
// Customers manage their own consent; support may read it but not write it,
// so a preference is never recorded against a customer who did not ask.
router.get('/preferences', requireRestApiEnabled, requireRestSession, consentController.getOwnPreferences);
router.put('/preferences', requireRestApiEnabled, requireRestSession, consentController.updateOwnPreferences);
router.get('/preferences/:userId', requireAdmin('compliance.read'), consentController.getCustomerPreferences);

// Customer privacy lifecycle (self-service): export own data, request erasure.
const privacyRouter = express.Router();
privacyRouter.post('/export', requireRestApiEnabled, requireRestSession, privacyController.exportOwnData);
privacyRouter.post('/erasure', requireRestApiEnabled, requireRestSession, privacyController.requestOwnErasure);
router.use('/privacy', privacyRouter);

module.exports = router;

