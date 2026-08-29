const express = require('express');
const router = express.Router();
const receiptController = require('../controllers/receipt.controller');

// Public, unauthenticated verification endpoint
router.get('/:id', receiptController.verifyReceipt);
router.get('/:id/verify', receiptController.verifyReceipt);

module.exports = router;