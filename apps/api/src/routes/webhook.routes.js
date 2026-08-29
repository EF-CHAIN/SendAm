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

// POST endpoint for incoming messages.
// Enforce a 30-second timeout, verify the WhatsApp signature, then validate the
// wire-format schema before processing (#321).
router.post(
  '/',
  requestTimeout(30000),
  verifyWhatsappSignature,
  validateExternalPayload('whatsapp.message'),
  webhookController.handleIncomingMessage,
);

// Handle errors from body parsing and request timeouts gracefully.
router.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    // TODO: Increment webhook_body_too_large metric.
    return res.status(413).json({ error: 'Request body too large' });
  }

  if (err.code === 'REQUEST_TIMEOUT') {
    // TODO: Increment webhook_timeout metric.
    return res.status(err.status).json({ error: 'Request timed out' });
  }

  next(err);
});

module.exports = router;
