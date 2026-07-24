const express = require('express');
const router = express.Router();
const createSimController = require('../controllers/sim.controller');

const simController = createSimController();

router.post('/message', simController.handleMessage);
router.get('/messages/:phone', simController.listMessages);

module.exports = router;
