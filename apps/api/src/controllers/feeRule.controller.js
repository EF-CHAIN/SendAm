'use strict';

// Admin API for the per-corridor fee schedule (#997). Rules are persisted in
// `FeeRule`, so pricing changes take effect on the next quote without a
// redeploy; the fee-rule cache is invalidated inside the service on every
// mutation.

const {
  listFeeRules,
  getFeeRuleById,
  createFeeRule,
  updateFeeRule,
  deleteFeeRule,
  previewFee,
} = require('../pricing/feeRule.service');
const { sendSuccess } = require('../utils/response');

const actorIdOf = (req) => req.admin?.id || req.admin?.email || null;

const requireId = (req) => {
  if (!req.params?.id) {
    const error = new Error('Fee rule id is required.');
    error.statusCode = 400;
    throw error;
  }
  return req.params.id;
};

const getFeeRules = async (req, res, next) => {
  try {
    const rules = await listFeeRules({ includeInactive: req.query?.includeInactive === 'true' });
    return sendSuccess(res, rules, 'Fee rules retrieved');
  } catch (error) {
    return next(error);
  }
};

const getFeeRule = async (req, res, next) => {
  try {
    const rule = await getFeeRuleById({ id: requireId(req) });
    if (!rule) {
      const error = new Error('Fee rule not found.');
      error.statusCode = 404;
      throw error;
    }
    return sendSuccess(res, rule, 'Fee rule retrieved');
  } catch (error) {
    return next(error);
  }
};

const create = async (req, res, next) => {
  try {
    const rule = await createFeeRule({ input: req.body, actorId: actorIdOf(req) });
    return sendSuccess(res, rule, 'Fee rule created', 201);
  } catch (error) {
    return next(error);
  }
};

const update = async (req, res, next) => {
  try {
    const rule = await updateFeeRule({ id: requireId(req), input: req.body, actorId: actorIdOf(req) });
    if (!rule) {
      const error = new Error('Fee rule not found.');
      error.statusCode = 404;
      throw error;
    }
    return sendSuccess(res, rule, 'Fee rule updated');
  } catch (error) {
    return next(error);
  }
};

const remove = async (req, res, next) => {
  try {
    const rule = await deleteFeeRule({ id: requireId(req), actorId: actorIdOf(req) });
    if (!rule) {
      const error = new Error('Fee rule not found.');
      error.statusCode = 404;
      throw error;
    }
    return sendSuccess(res, rule, 'Fee rule deleted');
  } catch (error) {
    return next(error);
  }
};

// Dry-run an amount against the live schedule before/after a change.
const preview = async (req, res, next) => {
  try {
    const { amount, asset, sourceCurrency, targetCurrency } = req.body;
    const quote = await previewFee({ amount, asset: asset || sourceCurrency, sourceCurrency, targetCurrency });
    return sendSuccess(res, quote, 'Fee preview calculated');
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getFeeRules,
  getFeeRule,
  create,
  update,
  remove,
  preview,
};
