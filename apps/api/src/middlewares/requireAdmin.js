const { verifyToken, hasPermission } = require('../services/adminAuth.service');
const { writeAuditLog } = require('../common/audit.service');
const { sendError } = require('../utils/response');
const authenticateAdmin = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const admin = await verifyToken(header.startsWith('Bearer ') ? header.slice(7) : null);
    if (!admin) return sendError(res, 'Unauthorized', 401);
    req.admin = admin; return next();
  } catch (error) { return next(error); }
};
const requirePermission = (permission, options = {}) => async (req, res, next) => {
  // Accounts that were provisioned from the shared legacy credential (or any
  // temporary credential) are locked out of admin work until they rotate the
  // password via POST /api/admin/password. This is what guarantees the shared
  // ADMIN_PASSWORD cannot authenticate real admin operations after migration.
  if (req.admin?.mustChangePassword && !options.allowPasswordChangePending) {
    await writeAuditLog({ actorType: 'administrator', actorId: req.admin.id, action: 'admin.passwordChange.required', metadata: { method: req.method, path: req.originalUrl }, req });
    return sendError(res, 'Password change required before admin access', 403, { code: 'PASSWORD_CHANGE_REQUIRED' });
  }
  if (hasPermission(req.admin, permission)) {
    await writeAuditLog({ actorType: 'administrator', actorId: req.admin.id, action: 'admin.route.accessed', metadata: { permission, method: req.method, path: req.originalUrl }, req });
    return next();
  }
  await writeAuditLog({ actorType: 'administrator', actorId: req.admin.id, action: 'admin.authorization.denied', metadata: { permission, method: req.method, path: req.originalUrl }, req });
  return sendError(res, 'Forbidden', 403);
};
const requireAdmin = (permission = 'admin.read') => [authenticateAdmin, requirePermission(permission)];
requireAdmin.authenticate = authenticateAdmin; requireAdmin.permission = requirePermission;
module.exports = requireAdmin;
