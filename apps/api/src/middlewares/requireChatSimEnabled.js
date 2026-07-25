const { sendError } = require('../utils/response');
const config = require('../config/env');

// Gate for the chat simulator endpoints (/api/sim/*). The sim is an
// unauthenticated dev/test harness and must never be reachable in a real
// deployment by accident. Returns 404 unless ENABLE_CHAT_SIM=true; mirrors
// the same production kill-switch pattern as requireRestApiEnabled.
const requireChatSimEnabled = (req, res, next) => {
  if (!config.features.chatSim) {
    return sendError(res, 'Not found', 404);
  }
  next();
};

module.exports = requireChatSimEnabled;
