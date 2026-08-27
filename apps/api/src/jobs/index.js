const { registerWhatsAppJobs } = require('./whatsapp.jobs');
const { startDepositPoller } = require('./deposits.jobs');
const { startAuditPoller } = require('./audit.jobs');

const registerJobs = () => {
  const whatsappWorker = registerWhatsAppJobs();
  const depositPoller = startDepositPoller();
  const auditPoller = startAuditPoller();
  return {
    whatsappWorker,
    stop: async () => {
      depositPoller.stop();
      auditPoller.stop();
    },
  };
};

module.exports = {
  registerJobs,
};
