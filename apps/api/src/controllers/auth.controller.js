const { createChallenge, verifyChallenge, revokeSession } = require('../services/restAuth.service');
const sep10Service = require('../services/sep10.service');
const { writeAuditLog } = require('../common/audit.service');
const { sendSuccess, sendError } = require('../utils/response');

const extractBearerOrBodyToken = (req) => {
  const authHeader = req.headers?.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return req.body?.token || null;
};

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

const sep10Challenge = async (req, res) => {
  try {
    const result = await sep10Service.createChallenge({
      account: req.query?.account,
      memo: req.query?.memo,
      home_domain: req.query?.home_domain || req.query?.homeDomain,
      client_domain: req.query?.client_domain || req.query?.clientDomain,
      client_signing_key: req.query?.client_signing_key || req.query?.clientSigningKey,
    });
    await writeAuditLog({
      actorType: 'stellar_account',
      actorId: req.query?.account,
      action: 'auth.sep10.challenge.created',
      metadata: {
        homeDomain: result.homeDomain,
        clientDomain: result.clientDomain || null,
      },
      req,
    });
    return res.status(200).json({
      success: true,
      message: 'Challenge created',
      transaction: result.transaction,
      network_passphrase: result.network_passphrase,
      networkPassphrase: result.networkPassphrase,
      home_domain: result.homeDomain,
      client_domain: result.clientDomain || null,
      expires_at: result.expiresAt,
      data: {
        transaction: result.transaction,
        network_passphrase: result.network_passphrase,
        networkPassphrase: result.networkPassphrase,
        homeDomain: result.homeDomain,
        clientDomain: result.clientDomain || null,
        expiresAt: result.expiresAt,
      },
    });
  } catch (error) {
    await writeAuditLog({
      actorType: 'anonymous',
      action: 'auth.sep10.challenge.failed',
      metadata: { reason: error.message },
      req,
    });
    const statusCode = error.statusCode || 400;
    return res.status(statusCode).json({
      success: false,
      error: error.message,
      message: error.message,
    });
  }
};

const sep10Token = async (req, res) => {
  try {
    const result = await sep10Service.verifyChallenge({
      transaction: req.body?.transaction,
      home_domain: req.body?.home_domain || req.body?.homeDomain,
      client_domain: req.body?.client_domain || req.body?.clientDomain,
    });
    await writeAuditLog({
      actorType: result.user?.id ? 'user' : 'stellar_account',
      actorId: result.user?.id || result.account,
      action: 'auth.sep10.session.created',
      metadata: {
        account: result.account,
        sub: result.sub,
        homeDomain: result.homeDomain,
        clientDomain: result.clientDomain,
      },
      req,
    });
    return res.status(200).json({
      success: true,
      message: 'Authenticated',
      token: result.token,
      expires_at: result.expiresAt,
      expiresAt: result.expiresAt,
      token_type: 'Bearer',
      tokenType: 'Bearer',
      data: {
        token: result.token,
        expiresAt: result.expiresAt,
        tokenType: 'Bearer',
        account: result.account,
        sub: result.sub,
        homeDomain: result.homeDomain,
        clientDomain: result.clientDomain,
      },
    });
  } catch (error) {
    await writeAuditLog({
      actorType: 'anonymous',
      action: 'auth.sep10.verification.failed',
      metadata: { reason: error.message },
      req,
    });
    const statusCode = error.statusCode || 401;
    return res.status(statusCode).json({
      success: false,
      error: error.message,
      message: error.message,
    });
  }
};

const sep10Refresh = async (req, res) => {
  try {
    const rawToken = extractBearerOrBodyToken(req);
    const result = await sep10Service.refreshToken(rawToken);
    await writeAuditLog({
      actorType: 'stellar_account',
      actorId: result.account,
      action: 'auth.sep10.token.refreshed',
      metadata: { homeDomain: result.homeDomain, clientDomain: result.clientDomain },
      req,
    });
    return res.status(200).json({
      success: true,
      message: 'Token refreshed',
      token: result.token,
      expires_at: result.expiresAt,
      expiresAt: result.expiresAt,
      token_type: 'Bearer',
      tokenType: 'Bearer',
      data: {
        token: result.token,
        expiresAt: result.expiresAt,
        tokenType: 'Bearer',
        account: result.account,
        sub: result.sub,
      },
    });
  } catch (error) {
    const statusCode = error.statusCode || 401;
    return res.status(statusCode).json({
      success: false,
      error: error.message,
      message: error.message,
    });
  }
};

const sep10Revoke = async (req, res) => {
  try {
    const rawToken = extractBearerOrBodyToken(req);
    const result = await sep10Service.revokeToken(rawToken);
    await writeAuditLog({
      actorType: 'stellar_account',
      actorId: result.tokenHash,
      action: 'auth.sep10.token.revoked',
      req,
    });
    return res.status(200).json({
      success: true,
      message: 'Token revoked',
      revoked: true,
      data: {
        revoked: true,
        tokenHash: result.tokenHash,
        revokedAt: result.revokedAt,
      },
    });
  } catch (error) {
    const statusCode = error.statusCode || 400;
    return res.status(statusCode).json({
      success: false,
      error: error.message,
      message: error.message,
    });
  }
};

module.exports = {
  challenge,
  token,
  logout,
  sep10Challenge,
  sep10Token,
  sep10Refresh,
  sep10Revoke,
};
