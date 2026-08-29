const express = require('express');
const router = express.Router();
const controller = require('./compliance.controller');
const privacyController = require('./privacy.controller');
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

router.post(
  '/kyc/:id/review',
  requireAdmin,
  validateRequest({
    params: {
      allowedKeys: ['id'],
      required: ['id'],
      fields: {
        id: {
          type: 'string',
          trim: true,
          custom: (value) => value.length > 0,
          message: 'KYC profile id is required',
        },
      },
    },
    body: {
      allowedKeys: ['status', 'tier', 'riskScore'],
      fields: {
        status: { type: 'string', optional: true },
        tier: { type: 'number', optional: true },
        riskScore: { type: 'number', optional: true },
      },
    },
  }),
  controller.reviewKyc,
);

router.post(
  '/pin',
  requireRestApiEnabled,
  validateRequest({
    body: {
      allowedKeys: ['phoneNumber', 'pin'],
      required: ['phoneNumber', 'pin'],
      fields: {
        phoneNumber: {
          type: 'string',
          trim: true,
          custom: (value) => value.length > 5,
          message: 'A valid phone number is required',
        },
        pin: {
          type: 'string',
          trim: true,
          custom: (value) => value.length >= 4,
          message: 'PIN must be at least 4 characters',
        },
      },
    },
  }),
  controller.setPin,
);

module.exports = router;
