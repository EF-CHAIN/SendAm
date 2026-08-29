const express = require('express');
const router = express.Router();
const walletController = require('../controllers/wallet.controller');
const { validateRequest } = require('../middlewares/validateRequest');

router.post(
  '/create',
  validateRequest({
    body: {
      allowedKeys: ['phoneNumber'],
      required: ['phoneNumber'],
      fields: {
        phoneNumber: {
          type: 'string',
          trim: true,
          custom: (value) => value.length > 5,
          message: 'A valid phone number is required',
        },
      },
    },
  }),
  walletController.createWallet,
);

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

router.post(
  '/send',
  validateRequest({
    body: {
      allowedKeys: ['phoneNumber', 'amount', 'destination', 'asset', 'routeType', 'sourceCountry', 'destinationCountry'],
      required: ['phoneNumber', 'amount', 'destination'],
      fields: {
        phoneNumber: {
          type: 'string',
          trim: true,
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
          custom: (value) => value.length >= 20,
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
