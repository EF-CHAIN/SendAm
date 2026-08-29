const axios = require('axios');
const config = require('../../config/env');
const { ProviderSkippedError } = require('../providerErrors');

// Best-effort deletion of a customer's data from the monitoring/observability
// provider. Gated behind an operator-configured deletion URL; when unconfigured
// it throws ProviderSkippedError so the privacy workflow records a visible
// "skipped" task rather than a failure.
const deleteUserData = async (user) => {
  const url = (config.monitoring && config.monitoring.deletionUrl) || process.env.MONITORING_DATA_DELETION_URL;
  if (!url) throw new ProviderSkippedError('Monitoring data deletion not configured');
  await axios.post(url, { userId: user.id, phoneNumber: user.phoneNumber }, {
    timeout: 30000,
    headers: { 'content-type': 'application/json' },
  });
  return { status: 'success' };
};

module.exports = { deleteUserData };
