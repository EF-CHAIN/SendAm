const { createChallenge, verifyChallenge, revokeSession } = require('../services/restAuth.service');
const { writeAuditLog } = require('../common/audit.service');
const { sendSuccess, sendError } = require('../utils/response');

const challenge = async (req, res) => {
  try {
    const result = await createChallenge(req.query.account);
    await writeAuditLog({ actorType: 'stellar_account', actorId: req.query.account, action: 'auth.challenge.created', req });
    return sendSuccess(res, result, 'Challenge created');
  } catch (error) {
    await writeAuditLog({ actorType: 'anonymous', action: 'auth.challenge.failed', metadata: { reason: error.message }, req });
    return sendError(res, error.message, 400);
  }
};

const token = async (req, res) => {
  try {
    const result = await verifyChallenge(req.body.transaction);
    await writeAuditLog({ actorType: 'user', actorId: result.user.id, action: 'auth.session.created', metadata: { account: result.account }, req });
    return sendSuccess(res, { token: result.token, expiresAt: result.expiresAt, tokenType: 'Bearer' }, 'Authenticated');
  } catch (error) {
    await writeAuditLog({ actorType: 'anonymous', action: 'auth.verification.failed', metadata: { reason: error.message }, req });
    return sendError(res, error.message, 401);
  }
};

const logout = async (req, res, next) => {
  try {
    await revokeSession(req.restSession.id);
    await writeAuditLog({ actorType: 'user', actorId: req.restUser.id, action: 'auth.session.revoked', req });
    return sendSuccess(res, null, 'Session revoked');
  } catch (error) { return next(error); }
};

module.exports = { challenge, token, logout };
