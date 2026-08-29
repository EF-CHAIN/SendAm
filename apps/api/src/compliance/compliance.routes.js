const express = require('express');
const router = express.Router();
const controller = require('./compliance.controller');
const privacyController = require('./privacy.controller');
const consentController = require('./consent.controller');
const requireAdmin = require('../middlewares/requireAdmin');
const requireRestApiEnabled = require('../middlewares/requireRestApiEnabled');
const requireRestSession = require('../middlewares/requireRestSession');
const { validateExternalPayload } = require('../common/validation');

router.get('/kyc/:phone', requireAdmin('compliance.read'), controller.getProfile);
router.get('/kyc', requireRestApiEnabled, requireRestSession, controller.getOwnProfile);
router.post('/kyc/start', requireRestApiEnabled, requireRestSession, controller.startKyc);
router.post('/kyc/callback/smileid', validateExternalPayload('smileid.callback'), controller.smileIdCallback);
router.post('/kyc/:id/review', requireAdmin('compliance.write'), controller.reviewKyc);
router.post('/kyc/:id/approve', requireAdmin('compliance.write'), controller.approveOverride);
router.post('/pin', requireRestApiEnabled, requireRestSession, controller.setPin);

// ── Onboarding status (#330) ────────────────────────────────────────────
// Customer self-service: retrieve their own onboarding checkpoints and next step.
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
