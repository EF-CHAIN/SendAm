const express = require('express');
const router = express.Router();
const verifyWebhook = require('../middlewares/verifyWebhook');
const verifyWhatsappSignature = require('../middlewares/verifyWhatsappSignature');
const webhookController = require('../controllers/webhook.controller');

// Parse JSON bodies with a size limit, preserving the raw request body for signature verification.
router.use(
  express.json({
    limit: '1mb',
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

// Middleware to enforce an execution timeout for requests.
function requestTimeout(milliseconds) {
  return (req, res, next) => {
    const timer = setTimeout(() => {
      const err = new Error('Request timed out');
      err.status = 408;
      err.code = 'REQUEST_TIMEOUT';
      next(err);
    }, milliseconds);

    res.once('finish', () => clearTimeout(timer));
    next();
  };
}

// GET endpoint for webhook verification (WhatsApp).
router.get('/', verifyWebhook, (req, res) => {
  res.status(200).send(req.query['hub.challenge']);
});

// POST endpoint for incoming messages.
// Enforce a 30-second timeout and verify the WhatsApp signature before processing.
router.post('/', requestTimeout(30000), verifyWhatsappSignature, webhookController.handleIncomingMessage);

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
