'use strict';

/**
 * Admin surface for continuous alert-delivery verification (#228).
 * Exposes the persisted operational state (overall health + last successful
 * end-to-end verification) so operators can tell at a glance whether the
 * alert-routing pipeline has been verified recently. Read-only; never returns
 * recipients or secrets.
 */
const prisma = require('../common/prisma');
const { getStatus } = require('../observability/alertDelivery.service');
const { sendSuccess } = require('../utils/response');

const getAlertDeliveryStatus = async (_req, res, next) => {
  try {
    return sendSuccess(res, await getStatus({ db: prisma }));
  } catch (error) {
    return next(error);
  }
};

module.exports = { getAlertDeliveryStatus };