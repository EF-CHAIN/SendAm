const express = require('express');
const router = express.Router();
const controller = require('./compliance.controller');
const privacyController = require('./privacy.controller');
const requireAdmin = require('../middlewares/requireAdmin');
const requireRestApiEnabled = require('../middlewares/requireRestApiEnabled');
const requireRestSession = require('../middlewares/requireRestSession');

router.get('/kyc/:phone', requireAdmin('compliance.read'), controller.getProfile);
router.get('/kyc', requireRestApiEnabled, requireRestSession, controller.getOwnProfile);
router.post('/kyc/start', requireRestApiEnabled, requireRestSession, controller.startKyc);
router.post('/kyc/callback/smileid', controller.smileIdCallback);
router.post('/kyc/:id/review', requireAdmin('compliance.write'), controller.reviewKyc);
router.post('/kyc/:id/approve', requireAdmin('compliance.write'), controller.approveOverride);
router.post('/pin', requireRestApiEnabled, requireRestSession, controller.setPin);

// Customer privacy lifecycle (self-service): export own data, request erasure.
const privacyRouter = express.Router();
privacyRouter.post('/export', requireRestApiEnabled, requireRestSession, privacyController.exportOwnData);
privacyRouter.post('/erasure', requireRestApiEnabled, requireRestSession, privacyController.requestOwnErasure);
router.use('/privacy', privacyRouter);

module.exports = router;
