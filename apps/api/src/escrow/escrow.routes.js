const express = require('express');
const router = express.Router();
const controller = require('./escrow.controller');
const requireAdmin = require('../middlewares/requireAdmin');

router.post('/', controller.create);
router.post('/:id/dispute', controller.dispute);
router.get('/', requireAdmin, controller.list);
router.post('/:id/release', requireAdmin, controller.release);
router.post('/:id/refund', requireAdmin, controller.refund);

module.exports = router;
