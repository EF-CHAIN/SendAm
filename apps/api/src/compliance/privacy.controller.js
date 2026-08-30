const { sendSuccess, sendError } = require('../utils/response');
const privacyService = require('./privacy.service');
const { withIdAlias } = require('../common/records');

// Self-service: a customer exports their own eligible data (portability).
const exportOwnData = async (req, res, next) => {
  try {
    const userId = req.restUser.id;
    const { request, data } = await privacyService.requestDataExport(userId, { req });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="privacy-export-${request.id}.json"`);
    return res.status(200).send(JSON.stringify(data, null, 2));
  } catch (error) {
    next(error);
  }
};

// Self-service: a customer requests erasure; requires admin approval.
const requestOwnErasure = async (req, res, next) => {
  try {
    const userId = req.restUser.id;
    const request = await privacyService.requestErasure(userId, { reason: req.body?.reason, requestedBy: 'self', req });
    return sendSuccess(res, withIdAlias(request), 'Erasure request submitted for review', 202);
  } catch (error) {
    if (error.statusCode) return sendError(res, error.message, error.statusCode);
    next(error);
  }
};

const listRequests = async (req, res, next) => {
  try {
    const requests = await privacyService.listRequests({ type: req.query.type, status: req.query.status });
    return sendSuccess(res, requests.map(withIdAlias));
  } catch (error) {
    next(error);
  }
};

const getRequest = async (req, res, next) => {
  try {
    const request = await privacyService.getRequest(req.params.id);
    return sendSuccess(res, withIdAlias(request));
  } catch (error) {
    if (error.statusCode) return sendError(res, error.message, error.statusCode);
    next(error);
  }
};

const approveRequest = async (req, res, next) => {
  try {
    const result = await privacyService.approveRequest({
      id: req.params.id,
      approvedBy: req.admin.id,
      decision: req.body?.decision || 'approve',
      req,
    });
    return sendSuccess(res, withIdAlias(result), 'Privacy request processed');
  } catch (error) {
    if (error.statusCode) return sendError(res, error.message, error.statusCode);
    next(error);
  }
};

const retryProviders = async (req, res, next) => {
  try {
    const result = await privacyService.retryProviders({ id: req.params.id, req });
    return sendSuccess(res, result, 'Provider deletion tasks retried');
  } catch (error) {
    if (error.statusCode) return sendError(res, error.message, error.statusCode);
    next(error);
  }
};

const setLegalHold = async (req, res, next) => {
  try {
    const hold = await privacyService.setLegalHold({
      userId: req.body?.userId,
      reason: req.body?.reason,
      heldBy: req.admin.id,
      expiresAt: req.body?.expiresAt,
      req,
    });
    return sendSuccess(res, withIdAlias(hold), 'Legal hold set', 201);
  } catch (error) {
    if (error.statusCode) return sendError(res, error.message, error.statusCode);
    next(error);
  }
};

const releaseLegalHold = async (req, res, next) => {
  try {
    const result = await privacyService.releaseLegalHold({ userId: req.params.userId, releasedBy: req.admin.id, req });
    return sendSuccess(res, result, 'Legal hold released');
  } catch (error) {
    next(error);
  }
};

const listLegalHolds = async (_req, res, next) => {
  try {
    const holds = await privacyService.listLegalHolds();
    return sendSuccess(res, holds.map(withIdAlias));
  } catch (error) {
    next(error);
  }
};

module.exports = {
  exportOwnData,
  requestOwnErasure,
  listRequests,
  getRequest,
  approveRequest,
  retryProviders,
  setLegalHold,
  releaseLegalHold,
  listLegalHolds,
};
