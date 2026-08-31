const { registerWhatsAppJobs } = require('./whatsapp.jobs');
const { startDepositPoller } = require('./deposits.jobs');
const { startAuditPoller } = require('./audit.jobs');
const { startVerificationExpiryPoller } = require('./verification.expiry.jobs');
const { startAlertDeliveryPoller } = require('./alertDelivery.jobs');

const registerJobs = () => {
  const whatsappWorker = registerWhatsAppJobs();
  const depositPoller = startDepositPoller();
  const auditPoller = startAuditPoller();
  const verificationExpiryPoller = startVerificationExpiryPoller();
  const alertDeliveryPoller = startAlertDeliveryPoller();
  return {
    whatsappWorker,
    processorNames: ['whatsapp-inbound'],
    stop: async () => {
      depositPoller.stop();
      auditPoller.stop();
      verificationExpiryPoller.stop();
      alertDeliveryPoller.stop();
    },
  };
};

module.exports = {
  registerJobs,
};
