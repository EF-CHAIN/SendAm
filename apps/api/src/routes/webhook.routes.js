const express = require('express');
const router = express.Router();
const verifyWebhook = require('../middlewares/verifyWebhook');
const verifyWhatsappSignature = require('../middlewares/verifyWhatsappSignature');
const webhookController = require('../controllers/webhook.controller');

// GET for verifying the webhook by WhatsApp
router.get('/', verifyWebhook, (req, res) => {
  res.status(200).send(req.query['hub.challenge']);
});

// POST for receiving messages — signature-checked before any processing.
router.post('/', verifyWhatsappSignature, webhookController.handleIncomingMessage);

module.exports = router;
