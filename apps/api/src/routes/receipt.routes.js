const express = require('express');
const router = express.Router();
const receiptController = require('../controllers/receipt.controller');
const { validateRequest } = require('../middlewares/validateRequest');

// Receipt ids are transaction ids (cuid), optionally carrying the public
// `SDA-` prefix. Reject anything else before it reaches the database.
const RECEIPT_ID_PATTERN = /^(SDA-)?[A-Za-z0-9_-]{1,64}$/;

const validateReceiptId = validateRequest({
  params: {
    allowedKeys: ['id'],
    required: ['id'],
    fields: {
      id: {
        type: 'string',
        custom: (value) => RECEIPT_ID_PATTERN.test(value),
        message: 'A valid receipt id is required',
      },
    },
  },
});

// Public, unauthenticated verification endpoint
router.get('/:id', validateReceiptId, receiptController.verifyReceipt);
router.get('/:id/verify', validateReceiptId, receiptController.verifyReceipt);

module.exports = router;
