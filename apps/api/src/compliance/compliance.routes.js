const express = require('express');
const router = express.Router();
const controller = require('./compliance.controller');
const requireAdmin = require('../middlewares/requireAdmin');
const requireRestApiEnabled = require('../middlewares/requireRestApiEnabled');

router.get('/kyc/:phone', requireAdmin, controller.getProfile);
router.post('/kyc/start', requireRestApiEnabled, controller.startKyc);
router.post('/kyc/:id/review', requireAdmin, controller.reviewKyc);
router.post('/pin', requireRestApiEnabled, controller.setPin);

module.exports = router;
