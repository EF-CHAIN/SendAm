const { findSession } = require('../services/restAuth.service');
const { sendError } = require('../utils/response');

module.exports = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const session = await findSession(header.startsWith('Bearer ') ? header.slice(7) : null);
    if (!session) return sendError(res, 'Unauthorized', 401);
    req.restSession = session;
    req.restUser = session.user;
    return next();
  } catch (error) {
    return next(error);
  }
};
