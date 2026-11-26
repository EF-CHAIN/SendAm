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
// Recovery-phrase export (#960). Tighter than /send and over a longer window,
// because the thing being protected is the key itself rather than one
// transfer's worth of value: a stolen secret key drains the wallet now and
// every time it is refilled. Three requests an hour is ample for a human
// exporting to Lobstr or Freighter, and leaves no room for grinding the
// 6-digit challenge by requesting fresh grants. The service bounds attempts
// WITHIN a grant; this bounds how many grants can be minted.
const exportLimiter = createAccountRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  prefix: 'wallet-export:',
});
// The verify step needs enough room for honest typos but not for a search:
// the per-grant attempt budget is the real wall, and this keeps a caller from
// spending it faster than a person could.
const exportVerifyLimiter = createAccountRateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  prefix: 'wallet-export-verify:',
});

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

// Emergency freeze endpoint (#964)
const { emergencyFreezeHandler } = require('../wallet/emergencyFreeze');
router.post('/emergency-freeze', emergencyFreezeHandler);
router.post('/freeze', emergencyFreezeHandler);
router.post('/:id/freeze', emergencyFreezeHandler);

router.post(
  '/send',
  sendLimiter,
  validateRequest({
    body: {
      allowedKeys: ['phoneNumber', 'amount', 'destination', 'asset', 'routeType', 'sourceCountry', 'destinationCountry', 'destinationAsset', 'destinationAmount', 'quoteId'],
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
        destinationAsset: { type: 'string', optional: true, trim: true },
        destinationAmount: { type: 'string', optional: true, trim: true },
        quoteId: { type: 'string', optional: true, trim: true },
        routeType: { type: 'string', optional: true },
        sourceCountry: { type: 'string', optional: true },
        destinationCountry: { type: 'string', optional: true },
      },
    },
  }),
  walletController.sendFunds,
);

// ── Recovery-phrase export (#960) ────────────────────────────────────────
//
// Three steps, deliberately separate requests: request a grant, prove BOTH
// factors, then claim the material once. `requireRestSession` above
// authenticates every one of them, and the controller re-checks that each
// grant belongs to the caller — the service takes a bare grantId and does not.
//
// Mounted before the `/:phone` patterns would matter, and under distinct
// paths, so `/export/...` can never be read as a phone number.
const mnemonicExportController = require('../controllers/mnemonicExport.controller');

const grantIdBody = {
  allowedKeys: ['grantId'],
  required: ['grantId'],
  fields: {
    grantId: {
      type: 'string',
      trim: true,
      custom: (value) => value.length > 0 && value.length <= 64,
      message: 'A valid grantId is required',
    },
  },
};

router.post(
  '/export/request',
  exportLimiter,
  validateRequest({
    body: {
      allowedKeys: ['walletId'],
      required: [],
      fields: {
        walletId: {
          type: 'string',
          trim: true,
          optional: true,
          custom: (value) => value.length > 0 && value.length <= 64,
          message: 'A valid walletId is required',
        },
      },
    },
  }),
  mnemonicExportController.requestExport,
);

router.post(
  '/export/verify',
  exportVerifyLimiter,
  validateRequest({
    body: {
      // `pin` and `code` are accepted but never echoed, logged or stored by
      // the controller; the service hashes/compares them and keeps neither.
      allowedKeys: ['grantId', 'code', 'pin'],
      required: ['grantId', 'code', 'pin'],
      fields: {
        grantId: grantIdBody.fields.grantId,
        code: {
          type: 'string',
          trim: true,
          custom: (value) => /^[0-9]{4,10}$/.test(value),
          message: 'A numeric verification code is required',
        },
        pin: {
          type: 'string',
          trim: true,
          custom: (value) => value.length >= 4 && value.length <= 64,
          message: 'A PIN is required',
        },
      },
    },
  }),
  mnemonicExportController.verifyExport,
);

router.post(
  '/export/claim',
  exportVerifyLimiter,
  validateRequest({ body: grantIdBody }),
  mnemonicExportController.claimExport,
);

router.post(
  '/export/revoke',
  exportVerifyLimiter,
  validateRequest({ body: grantIdBody }),
  mnemonicExportController.revokeExport,
);

module.exports = router;
