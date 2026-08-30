const express = require('express');
const router = express.Router();
const controller = require('./compliance.controller');
const privacyController = require('./privacy.controller');
const consentController = require('./consent.controller');
const requireAdmin = require('../middlewares/requireAdmin');
const requireRestApiEnabled = require('../middlewares/requireRestApiEnabled');
const { validateRequest } = require('../middlewares/validateRequest');

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

router.post(
  '/kyc/start',
  requireRestApiEnabled,
  validateRequest({
    body: {
      allowedKeys: ['phoneNumber', 'providerReference'],
      required: ['phoneNumber'],
      fields: {
        phoneNumber: {
          type: 'string',
          trim: true,
          custom: (value) => value.length > 5,
          message: 'A valid phone number is required',
        },
        providerReference: { type: 'string', optional: true },
      },
    },
  }),
  controller.startKyc,
);

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
