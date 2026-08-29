const { registerWhatsAppJobs } = require('./whatsapp.jobs');
const { startDepositPoller } = require('./deposits.jobs');
const { startAuditPoller } = require('./audit.jobs');
const { startVerificationExpiryPoller } = require('./verification.expiry.jobs');
const { startRetentionSweep } = require('./retention.jobs');

const registerJobs = () => {
  const whatsappWorker = registerWhatsAppJobs();
  const depositPoller = startDepositPoller();
  const auditPoller = startAuditPoller();
  const verificationExpiryPoller = startVerificationExpiryPoller();
  const retentionSweep = startRetentionSweep();
  return {
    whatsappWorker,
    processorNames: ['whatsapp-inbound'],
    stop: async () => {
      depositPoller.stop();
      auditPoller.stop();
      verificationExpiryPoller.stop();
      retentionSweep.stop();
    },
  };
};

module.exports = {
  registerJobs,
};
