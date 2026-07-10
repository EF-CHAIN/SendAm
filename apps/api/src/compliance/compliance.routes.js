const express = require('express');
const router = express.Router();
const controller = require('./compliance.controller');
const requireAdmin = require('../middlewares/requireAdmin');

router.get('/kyc/:phone', requireAdmin, controller.getProfile);
router.post('/kyc/start', controller.startKyc);
router.post('/kyc/:id/review', requireAdmin, controller.reviewKyc);
router.post('/pin', controller.setPin);

module.exports = router;
