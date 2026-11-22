const express = require('express');
const router = express.Router();
const { createQuote } = require('./pricing.service');
const { getCorridorIndicativePrices, createFirmCorridorQuote } = require('./quote.service');
const { sendSuccess } = require('../utils/response');
const requireRestSession = require('../middlewares/requireRestSession');
const { validateRequest } = require('../middlewares/validateRequest');

const extractBearerJwt = (req) => {
  const authHeader = req.headers?.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return req.body?.jwt || req.query?.jwt || null;
};

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

router.get(
  '/sep38/prices',
  validateRequest({
    query: {
      allowedKeys: [
        'quoteServerUrl',
        'sourceCurrency',
        'targetCurrency',
        'sellAsset',
        'buyAsset',
        'sourceAmount',
        'sellAmount',
        'buyAmount',
        'context',
        'sellDeliveryMethod',
        'buyDeliveryMethod',
        'countryCode',
        'jwt',
      ],
      fields: {
        quoteServerUrl: { type: 'string', optional: true, trim: true },
        sourceCurrency: { type: 'string', optional: true, trim: true },
        targetCurrency: { type: 'string', optional: true, trim: true },
        sellAsset: { type: 'string', optional: true, trim: true },
        buyAsset: { type: 'string', optional: true, trim: true },
        sourceAmount: { type: 'string', optional: true, trim: true },
        sellAmount: { type: 'string', optional: true, trim: true },
        buyAmount: { type: 'string', optional: true, trim: true },
        context: { type: 'string', optional: true, trim: true },
        sellDeliveryMethod: { type: 'string', optional: true, trim: true },
        buyDeliveryMethod: { type: 'string', optional: true, trim: true },
        countryCode: { type: 'string', optional: true, trim: true },
        jwt: { type: 'string', optional: true, trim: true },
      },
    },
  }),
  async (req, res, next) => {
    try {
      const prices = await getCorridorIndicativePrices({
        ...req.query,
        jwt: extractBearerJwt(req),
      });
      return sendSuccess(res, prices, 'SEP-38 indicative prices retrieved');
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/sep38/quote',
  validateRequest({
    body: {
      allowedKeys: [
        'userId',
        'sourceCurrency',
        'targetCurrency',
        'sellAsset',
        'buyAsset',
        'sourceAmount',
        'sellAmount',
        'buyAmount',
        'context',
        'quoteServerUrl',
        'jwt',
        'lockDurationSeconds',
        'sellDeliveryMethod',
        'buyDeliveryMethod',
        'countryCode',
        'route',
        'idempotencyKey',
      ],
      fields: {
        userId: { type: 'string', optional: true, trim: true },
        sourceCurrency: { type: 'string', optional: true, trim: true },
        targetCurrency: { type: 'string', optional: true, trim: true },
        sellAsset: { type: 'string', optional: true, trim: true },
        buyAsset: { type: 'string', optional: true, trim: true },
        sourceAmount: { type: 'string', optional: true, trim: true },
        sellAmount: { type: 'string', optional: true, trim: true },
        buyAmount: { type: 'string', optional: true, trim: true },
        context: { type: 'string', optional: true, trim: true },
        quoteServerUrl: { type: 'string', optional: true, trim: true },
        jwt: { type: 'string', optional: true, trim: true },
        lockDurationSeconds: { type: 'number', optional: true },
        sellDeliveryMethod: { type: 'string', optional: true, trim: true },
        buyDeliveryMethod: { type: 'string', optional: true, trim: true },
        countryCode: { type: 'string', optional: true, trim: true },
        route: { type: 'string', optional: true, trim: true },
        idempotencyKey: { type: 'string', optional: true, trim: true },
      },
    },
  }),
  async (req, res, next) => {
    try {
      const quote = await createFirmCorridorQuote({
        ...req.body,
        userId: req.body?.userId || req.restUser?.id || null,
        jwt: extractBearerJwt(req),
      });
      return sendSuccess(res, quote, 'SEP-38 firm quote generated', 201);
    } catch (error) {
      next(error);
    }
  },
);

module.exports = router;

