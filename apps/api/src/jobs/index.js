const { registerWhatsAppJobs } = require('./whatsapp.jobs');
const { startDepositPoller } = require('./deposits.jobs');
const { startAuditPoller } = require('./audit.jobs');
const { JOB_NAME, runRotationHealthCheck, rotateCategorySecret } = require('./secret-rotation.job');
const { startWebhookInboxDrain, startOutboxReconciler } = require('./messaging.jobs');
const { startAlertDeliveryTestPoller } = require('../observability/alertDeliveryTest.service');
const { enqueue, registerProcessor } = require('../queues/queue.service');
const config = require('../config/env');
const prisma = require('../common/prisma');
const logger = require('../utils/logger');

const registerSecretRotationJobs = () => {
  registerProcessor(JOB_NAME, async (job, _token) => {
    const action = job.name;
    if (action === 'health-check') {
      return runRotationHealthCheck();
    }
    if (action === 'rotate') {
      const { category, rotatedBy } = job.data || {};
      return rotateCategorySecret({ category, rotatedBy });
    }
    throw new Error(`Unknown secret rotation job action: ${action}`);
  });

  const startRotationScheduler = () => {
    const intervalMs = (config.worker?.lockDurationMs || 30000) * 2;
    setInterval(async () => {
      try {
        await enqueue('sendam-jobs', JOB_NAME, { action: 'health-check' }, { jobId: `rotation-health-${Date.now()}` });
      } catch (error) {
        logger.warn('secret_rotation_schedule_failed', { error: error.message });
      }
    }, intervalMs).unref();
    logger.info('secret_rotation_scheduler_started', { intervalMs });
  };

  return { startRotationScheduler };
};

const registerJobs = () => {
  const whatsappWorker = registerWhatsAppJobs();
  const depositPoller = startDepositPoller();
  const auditPoller = startAuditPoller();
  const rotationJobs = registerSecretRotationJobs();
  const inboxDrain = startWebhookInboxDrain();
  const outboxReconciler = startOutboxReconciler();

  // Only start the alert delivery test poller when at least one route is
  // configured. An interval of 0 is an explicit disable signal.
  let alertDeliveryPoller = null;
  if (config.alertDeliveryTest?.intervalMs > 0) {
    alertDeliveryPoller = startAlertDeliveryTestPoller({ db: prisma, config });
  } else {
    logger.info('alert_delivery_test_poller_disabled', { reason: 'ALERT_DELIVERY_TEST_INTERVAL_MS=0' });
  }

  return {
    whatsappWorker,
    depositPoller,
    auditPoller,
    rotationJobs,
    inboxDrain,
    outboxReconciler,
    alertDeliveryPoller,
    processorNames: ['whatsapp-inbound'],
    stop: async () => {
      depositPoller.stop();
      auditPoller.stop();
      inboxDrain.stop();
      outboxReconciler.stop();
      alertDeliveryPoller?.stop();
    },
  };
};

module.exports = {
  registerJobs,
};
