const { sendError } = require('../utils/response');
const config = require('../config/env');

// Gate for endpoints that, like the REST wallet API, treat the phone number
// in the request body as the only identity with no real per-user auth behind
// it. Reuses the same production kill-switch (ENABLE_WALLET_REST_API): off in
// production by default, on elsewhere for local testing.
const requireRestApiEnabled = (req, res, next) => {
  if (!config.features.walletRestApi) {
    return sendError(res, 'Not found', 404);
  }
  next();
};

module.exports = requireRestApiEnabled;
