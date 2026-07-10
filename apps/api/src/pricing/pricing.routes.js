const express = require('express');
const router = express.Router();
const { createQuote } = require('./pricing.service');
const { sendSuccess } = require('../utils/response');

router.post('/quote', async (req, res, next) => {
  try {
    const quote = await createQuote(req.body);
    return sendSuccess(res, quote, 'Quote generated');
  } catch (error) {
    next(error);
  }
});

module.exports = router;
