const { registerWhatsAppJobs } = require('./whatsapp.jobs');
const { startDepositPoller } = require('./deposits.jobs');

const registerJobs = () => {
  registerWhatsAppJobs();
  startDepositPoller();
};

module.exports = {
  registerJobs,
};
