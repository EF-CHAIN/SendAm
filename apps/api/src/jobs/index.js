const { registerWhatsAppJobs } = require('./whatsapp.jobs');

const registerJobs = () => {
  registerWhatsAppJobs();
};

module.exports = {
  registerJobs,
};
