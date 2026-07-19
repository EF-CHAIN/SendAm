const express = require('express');
const router = express.Router();
const createSimController = require('../controllers/sim.controller');
const requireRestApiEnabled = require('../middlewares/requireRestApiEnabled');

const simController = createSimController();

router.post('/message', requireRestApiEnabled, simController.handleMessage);
router.get('/messages/:phone', requireRestApiEnabled, simController.listMessages);

module.exports = router;
