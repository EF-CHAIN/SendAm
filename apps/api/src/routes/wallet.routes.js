const express = require('express');
const router = express.Router();
const walletController = require('../controllers/wallet.controller');
const requireRestApiEnabled = require('../middlewares/requireRestApiEnabled');
const requireRestSession = require('../middlewares/requireRestSession');
const createAccountRateLimit = require('../middlewares/accountRateLimit');
const { validateRequest } = require('../middlewares/validateRequest');

// General per-account ceiling for the wallet REST API, plus a much tighter
// one on /send since it moves funds and is the highest-value abuse target.
const walletLimiter = createAccountRateLimit({ windowMs: 60 * 1000, max: 30, prefix: 'wallet:' });
const sendLimiter = createAccountRateLimit({ windowMs: 60 * 1000, max: 5, prefix: 'wallet-send:' });

router.use(requireRestApiEnabled);
router.use(requireRestSession);
router.use(walletLimiter);

router.post(
  '/create',
  validateRequest({
    body: {
      allowedKeys: ['phoneNumber'],
      required: [],
      fields: {
        phoneNumber: {
          type: 'string',
          trim: true,
          optional: true,
          custom: (value) => value.length > 5,
          message: 'A valid phone number is required',
        },
      },
    },
  }),
  walletController.createWallet,
);

// Self-service balance
router.get('/balance', walletController.checkBalance);

router.get(
  '/:phone/balance',
  validateRequest({
    params: {
      allowedKeys: ['phone'],
      required: ['phone'],
      fields: {
        phone: {
          type: 'string',
          trim: true,
          custom: (value) => value.length > 5,
          message: 'A valid phone number is required',
        },
      },
    },
  }),
  walletController.checkBalance,
);

// Self-service transactions
router.get('/transactions', walletController.getTransactionHistory);

router.get(
  '/:phone/transactions',
  validateRequest({
    params: {
      allowedKeys: ['phone'],
      required: ['phone'],
      fields: {
        phone: {
          type: 'string',
          trim: true,
          custom: (value) => value.length > 5,
          message: 'A valid phone number is required',
        },
      },
    },
  }),
  walletController.getTransactionHistory,
);

// Statement generation and export (#308)
router.get('/statement', walletController.getStatement);
router.get('/statement/export', walletController.getStatement);

router.post(
  '/send',
  sendLimiter,
  validateRequest({
    body: {
      allowedKeys: ['phoneNumber', 'amount', 'destination', 'asset', 'routeType', 'sourceCountry', 'destinationCountry'],
      required: ['amount', 'destination'],
      fields: {
        phoneNumber: {
          type: 'string',
          trim: true,
          optional: true,
          custom: (value) => value.length > 5,
          message: 'A valid phone number is required',
        },
        amount: {
          type: 'string',
          trim: true,
          custom: (value) => Number(value) > 0,
          message: 'Amount must be greater than zero',
        },
        destination: {
          type: 'string',
          trim: true,
          custom: (value) => value.length >= 5,
          message: 'Destination must be a valid Stellar address',
        },
        asset: { type: 'string', optional: true },
        routeType: { type: 'string', optional: true },
        sourceCountry: { type: 'string', optional: true },
        destinationCountry: { type: 'string', optional: true },
      },
    },
  }),
  walletController.sendFunds,
);

module.exports = router;
