const express = require('express');
const router = express.Router();
const verifyWebhook = require('../middlewares/verifyWebhook');
const webhookController = require('../controllers/webhook.controller');

// GET for verifying the webhook by WhatsApp
router.get('/', verifyWebhook, (req, res) => {
  res.status(200).send(req.query['hub.challenge']);
});

// POST for receiving messages
router.post('/', webhookController.handleIncomingMessage);

module.exports = router;
