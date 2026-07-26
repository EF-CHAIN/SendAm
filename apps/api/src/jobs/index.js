const { registerWhatsAppJobs } = require('./whatsapp.jobs');
const { startPoller } = require('./poller');

const registerJobs = () => {
  registerWhatsAppJobs();
  startPoller();
};

module.exports = {
  registerJobs,
};