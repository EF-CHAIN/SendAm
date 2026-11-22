'use strict';

const express = require('express');
const sep24Client = require('../services/sep24.client');
const { writeAuditLog } = require('../common/audit.service');
const { sendSuccess, sendError } = require('../utils/response');

const router = express.Router();

const extractBearerJwt = (req) => {
  const authHeader = req.headers?.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return req.body?.jwt || req.body?.token || req.query?.jwt || null;
};

router.use(express.json());
router.use(express.urlencoded({ extended: false }));

router.get('/info', async (req, res) => {
  try {
    const info = await sep24Client.getInfo({
      transferServerUrl: req.query?.transferServerUrl || req.query?.transfer_server_url,
      lang: req.query?.lang,
    });
    return sendSuccess(res, info, 'SEP-24 anchor info retrieved');
  } catch (error) {
    return sendError(res, error.message, error.statusCode || 502);
  }
});

const handleInteractiveStart = (kind) => async (req, res) => {
  try {
    const jwt = extractBearerJwt(req);
    const result = await sep24Client.startInteractiveFlow({
      ...req.body,
      kind,
      jwt,
      userId: req.body?.userId || req.restUser?.id || null,
      phoneNumber: req.body?.phoneNumber || req.restUser?.phoneNumber || null,
    });

    await writeAuditLog({
      actorType: req.restUser?.id ? 'user' : 'stellar_account',
      actorId: req.restUser?.id || req.body?.account || req.body?.userId || 'sep24',
      action: `sep24.${kind}.initiated`,
      entityType: 'Transaction',
      entityId: result.transactionId || result.anchorTransactionId,
      metadata: {
        kind: result.kind,
        anchorTransactionId: result.anchorTransactionId,
        shortCode: result.shortCode,
      },
      req,
    });

    return res.status(200).json({
      success: true,
      message: `Interactive SEP-24 ${kind} session initiated`,
      type: result.type,
      id: result.anchorTransactionId,
      url: result.interactiveUrl,
      shortUrl: result.shortUrl,
      shortCode: result.shortCode,
      data: result,
    });
  } catch (error) {
    await writeAuditLog({
      actorType: 'anonymous',
      action: `sep24.${kind}.failed`,
      metadata: { reason: error.message },
      req,
    });
    return sendError(res, error.message, error.statusCode || 400);
  }
};

router.post('/deposit/interactive', handleInteractiveStart('deposit'));
router.post('/transactions/deposit/interactive', handleInteractiveStart('deposit'));
router.post('/withdraw/interactive', handleInteractiveStart('withdrawal'));
router.post('/transactions/withdraw/interactive', handleInteractiveStart('withdrawal'));

router.get('/transaction', async (req, res) => {
  try {
    const jwt = extractBearerJwt(req);
    const transaction = await sep24Client.getTransaction({
      transferServerUrl: req.query?.transferServerUrl || req.query?.transfer_server_url,
      jwt,
      id: req.query?.id,
      stellar_transaction_id: req.query?.stellar_transaction_id || req.query?.stellarTransactionId,
      external_transaction_id: req.query?.external_transaction_id || req.query?.externalTransactionId,
      lang: req.query?.lang,
    });
    return res.status(200).json({
      success: true,
      transaction,
      data: { transaction },
    });
  } catch (error) {
    return sendError(res, error.message, error.statusCode || 400);
  }
});

router.get('/r/:code', async (req, res) => {
  try {
    const session = await sep24Client.resolveShortLink(req.params.code);
    if (!session || !session.interactiveUrl) {
      return sendError(res, 'Interactive payment link is invalid or has expired', 404);
    }
    if (req.query?.format === 'json') {
      return sendSuccess(res, session, 'Short link resolved');
    }
    return res.redirect(302, session.interactiveUrl);
  } catch (error) {
    return sendError(res, error.message, error.statusCode || 500);
  }
});

router.post('/callback', async (req, res) => {
  try {
    const result = await sep24Client.handleAnchorCallback(req.body);
    await writeAuditLog({
      actorType: 'provider',
      actorId: 'sep24_anchor',
      action: 'sep24.callback.received',
      entityType: 'Transaction',
      entityId: result.transactionId || result.anchorTransactionId,
      metadata: {
        anchorTransactionId: result.anchorTransactionId,
        anchorStatus: result.anchorStatus,
        internalStatus: result.internalStatus,
        kind: result.kind,
      },
      req,
    });
    return sendSuccess(res, result, 'SEP-24 transaction callback processed');
  } catch (error) {
    await writeAuditLog({
      actorType: 'provider',
      actorId: 'sep24_anchor',
      action: 'sep24.callback.failed',
      metadata: { reason: error.message },
      req,
    });
    return sendError(res, error.message, error.statusCode || 400);
  }
});

module.exports = router;
