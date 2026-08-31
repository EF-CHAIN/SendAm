const express = require('express');
const router = express.Router();
const { createQuote } = require('./pricing.service');
const { sendSuccess } = require('../utils/response');
const { validateRequest } = require('../middlewares/validateRequest');

router.post(
  '/quote',
  validateRequest({
    body: {
      allowedKeys: ['baseCurrency', 'quoteCurrency', 'amount', 'sourceCountry', 'destinationCountry', 'routeType'],
      required: ['baseCurrency', 'quoteCurrency', 'amount'],
      fields: {
        baseCurrency: { type: 'string', trim: true, custom: (value) => value.length > 0, message: 'baseCurrency is required' },
        quoteCurrency: { type: 'string', trim: true, custom: (value) => value.length > 0, message: 'quoteCurrency is required' },
        amount: {
          type: 'string',
          trim: true,
          custom: (value) => Number(value) > 0,
          message: 'amount must be greater than zero',
        },
        sourceCountry: { type: 'string', optional: true },
        destinationCountry: { type: 'string', optional: true },
        routeType: { type: 'string', optional: true },
      },
    },
  }),
  async (req, res, next) => {
    try {
      const quote = await createQuote(req.body);
      return sendSuccess(res, quote, 'Quote generated');
    } catch (error) {
      next(error);
    }
  },
);

module.exports = router;

