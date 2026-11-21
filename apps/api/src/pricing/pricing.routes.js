const express = require('express');
const router = express.Router();
const { createQuote } = require('./pricing.service');
const { sendSuccess } = require('../utils/response');
const requireRestSession = require('../middlewares/requireRestSession');
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
  (req, res, next) => req.headers.authorization ? requireRestSession(req, res, next) : next(),
  async (req, res, next) => {
    try {
      const quote = await createQuote({
        userId: req.restUser?.id,
        sourceCurrency: req.body.baseCurrency,
        targetCurrency: req.body.quoteCurrency,
        sourceAmount: req.body.amount,
        route: req.body.routeType,
      });
      return sendSuccess(res, quote, 'Quote generated');
    } catch (error) {
      next(error);
    }
  },
);

module.exports = router;

