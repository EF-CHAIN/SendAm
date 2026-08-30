const { registerWhatsAppJobs } = require('./whatsapp.jobs');
const { startDepositPoller } = require('./deposits.jobs');
const { startAuditPoller } = require('./audit.jobs');
const { startWebhookInboxDrain, startOutboxReconciler } = require('./messaging.jobs');

const registerJobs = () => {
  const whatsappWorker = registerWhatsAppJobs();
  const depositPoller = startDepositPoller();
  const auditPoller = startAuditPoller();
  const inboxDrain = startWebhookInboxDrain();
  const outboxReconciler = startOutboxReconciler();
  return {
    whatsappWorker,
    processorNames: ['whatsapp-inbound'],
    stop: async () => {
      depositPoller.stop();
      auditPoller.stop();
      inboxDrain.stop();
      outboxReconciler.stop();
    },
  };
};

module.exports = {
  registerJobs,
};
