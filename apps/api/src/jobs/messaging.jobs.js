'use strict';

// Background drains for the outbound outbox (#286) and the inbound webhook
// inbox (#287).
//
// The webhook handler drains the inbox inline for promptness, but that best
// effort is not a guarantee: a status whose processing fails is left durable
// and retried here, with backoff, until it succeeds or is dead-lettered. The
// outbound sweep flags sends that were claimed and never resolved, which is
// what a crash mid-send looks like.

const logger = require('../utils/logger');
const prisma = require('../common/prisma');
const webhookInbox = require('../services/webhookInbox.service');
const outbox = require('../services/notificationOutbox.service');
const { recordDeliveryStatus } = require('../services/whatsapp.service');
const { increment } = require('../observability/metrics');

const DEFAULT_INBOX_INTERVAL_MS = 30 * 1000;
const DEFAULT_OUTBOX_INTERVAL_MS = 5 * 60 * 1000;

/** Sends claimed but unresolved for this long are treated as crashed. */
const UNRESOLVED_AFTER_MS = 5 * 60 * 1000;

const startWebhookInboxDrain = ({
  intervalMs = DEFAULT_INBOX_INTERVAL_MS,
  db = prisma,
  handler = (event) => recordDeliveryStatus(event.payload),
} = {}) => {
  logger.info(`Webhook inbox drain started (interval: ${intervalMs}ms)`);

  const runDrain = async () => {
    try {
      const result = await webhookInbox.drainInbox(db, handler);
      if (result.processed || result.failed) {
        logger.info('webhook_inbox_drained', result);
      }

      // Backlog age matters more than depth: a small queue that is not moving
      // is the real failure, and is what should page someone.
      const stats = await webhookInbox.inboxStats(db);
      increment('sendam_webhook_inbox_backlog', { size: String(stats.backlog) });
      if (stats.deadLettered > 0) {
        logger.warn('webhook_inbox_dead_letters', { count: stats.deadLettered });
      }
    } catch (error) {
      logger.error(`Webhook inbox drain failed: ${error.message}`);
    }
  };

  runDrain();

  const timer = setInterval(runDrain, intervalMs);
  if (timer.unref) timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
      logger.info('Webhook inbox drain stopped.');
    },
  };
};

const startOutboxReconciler = ({
  intervalMs = DEFAULT_OUTBOX_INTERVAL_MS,
  olderThanMs = UNRESOLVED_AFTER_MS,
  db = prisma,
} = {}) => {
  logger.info(`Notification outbox reconciler started (interval: ${intervalMs}ms)`);

  const runSweep = async () => {
    try {
      const flagged = await outbox.reconcileUnresolvedSends(db, { olderThanMs });
      if (flagged.length) {
        increment('sendam_notification_unresolved_total', { count: String(flagged.length) });
      }
    } catch (error) {
      logger.error(`Notification outbox reconciliation failed: ${error.message}`);
    }
  };

  runSweep();

  const timer = setInterval(runSweep, intervalMs);
  if (timer.unref) timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
      logger.info('Notification outbox reconciler stopped.');
    },
  };
};

module.exports = {
  startWebhookInboxDrain,
  startOutboxReconciler,
  UNRESOLVED_AFTER_MS,
};
