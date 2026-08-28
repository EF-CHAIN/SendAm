const express = require('express');
const router = express.Router();
const verifyWebhook = require('../middlewares/verifyWebhook');
const verifyWhatsappSignature = require('../middlewares/verifyWhatsappSignature');
const webhookController = require('../controllers/webhook.controller');
const { validateRequest } = require('../middlewares/validateRequest');

// GET for verifying the webhook by WhatsApp
router.get(
  '/',
  validateRequest({
    query: {
      allowedKeys: ['hub.mode', 'hub.verify_token', 'hub.challenge'],
      required: ['hub.mode', 'hub.verify_token', 'hub.challenge'],
      fields: {
        'hub.mode': { type: 'string', trim: true, custom: (value) => value.length > 0, message: 'hub.mode is required' },
        'hub.verify_token': { type: 'string', trim: true, custom: (value) => value.length > 0, message: 'hub.verify_token is required' },
        'hub.challenge': { type: 'string', trim: true, custom: (value) => value.length > 0, message: 'hub.challenge is required' },
      },
    },
  }),
  verifyWebhook,
  (req, res) => {
    res.status(200).send(req.query['hub.challenge']);
  },
);

// POST for receiving messages — signature-checked before any processing.
router.post('/', verifyWhatsappSignature, webhookController.handleIncomingMessage);

module.exports = router;
