const crypto = require('crypto');
const { promisify } = require('util');
const prisma = require('../common/prisma');
const config = require('../config/env');
const scrypt = promisify(crypto.scrypt);
const TTL_MS = config.admin.sessionTtlHours * 60 * 60 * 1000;
const ADMIN_PERMISSIONS = [
  'stats:read',
  'users:read',
  'wallets:read',
  'transactions:read',
  'kyc:read',
  'audit:read',
  'system:read',
  'sensitive:reveal',
];

const sign = (body) =>
  crypto.createHmac('sha256', JWT_SECRET).update(body).digest('base64url');

// Constant-time string compare that tolerates length differences without
// throwing (timingSafeEqual requires equal-length buffers).
const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};
const verifyPassword = async (candidate, encoded) => {
  if (typeof candidate !== 'string' || !encoded) return false;
  const [algorithm, saltText, hashText] = encoded.split('$');
  if (algorithm !== 'scrypt' || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, 'base64url');
  const actual = await scrypt(candidate, Buffer.from(saltText, 'base64url'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
};

const createToken = () => {
  const payload = { role: 'admin', permissions: ADMIN_PERMISSIONS, iat: Date.now(), exp: Date.now() + TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
};
const authenticate = async (email, password) => {
  const normalized = normalizeEmail(email);
  let admin = await prisma.adminUser.findUnique({ where: { email: normalized }, include: { role: true } });
  if (!admin) admin = await bootstrapLegacyAdministrator(normalized, password);
  if (!admin || admin.disabledAt || !await verifyPassword(password, admin.passwordHash)) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  const session = await prisma.adminSession.create({ data: { adminId: admin.id, tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + TTL_MS) } });
  await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
  return { token, session, admin, mustChangePassword: admin.mustChangePassword === true };
};

module.exports = {
  ADMIN_PERMISSIONS,
  verifyPassword,
  createToken,
  verifyToken,
};
const hasPermission = (admin, permission) => Boolean(admin?.permissions?.includes('*') || admin?.permissions?.includes(permission));
const createInvitation = async ({ email, name, roleName, createdById }) => {
  const role = await prisma.adminRole.findUnique({ where: { name: roleName } });
  if (!role || !ROLE_PERMISSIONS[roleName]) throw Object.assign(new Error('Invalid role'), { statusCode: 400 });
  if (await prisma.adminUser.findUnique({ where: { email: normalizeEmail(email) } })) throw Object.assign(new Error('Administrator already exists'), { statusCode: 409 });
  const token = crypto.randomBytes(32).toString('base64url');
  const invitation = await prisma.adminInvitation.create({ data: { email: normalizeEmail(email), name: String(name || '').trim(), roleId: role.id, tokenHash: tokenHash(token), createdById, expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000) } });
  return { invitation, token };
};
const acceptInvitation = async (token, password) => prisma.$transaction(async (tx) => {
  const invitation = await tx.adminInvitation.findUnique({ where: { tokenHash: tokenHash(token) } });
  if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= new Date()) throw Object.assign(new Error('Invitation is invalid or expired'), { statusCode: 400 });
  const admin = await tx.adminUser.create({ data: { email: invitation.email, name: invitation.name, roleId: invitation.roleId, passwordHash: await hashPassword(password) } });
  await tx.adminInvitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } }); return admin;
});
const revokeSessions = (adminId, exceptSessionId) => prisma.adminSession.updateMany({ where: { adminId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) }, data: { revokedAt: new Date() } });
const changeOwnPassword = async ({ adminId, currentPassword, newPassword, sessionId }) => prisma.$transaction(async (tx) => {
  if (typeof newPassword !== 'string' || newPassword.length < 12) throw Object.assign(new Error('Password must be at least 12 characters'), { statusCode: 400 });
  const admin = await tx.adminUser.findUnique({ where: { id: adminId } });
  if (!admin || !await verifyPassword(currentPassword, admin.passwordHash)) throw Object.assign(new Error('Current password is incorrect'), { statusCode: 403 });
  if (admin.mustChangePassword !== true && await verifyPassword(newPassword, admin.passwordHash)) throw Object.assign(new Error('New password must differ from the current password'), { statusCode: 400 });
  const passwordHash = await hashPassword(newPassword);
  await tx.adminUser.update({ where: { id: adminId }, data: { passwordHash, mustChangePassword: false, passwordChangedAt: new Date() } });
  await tx.adminSession.updateMany({ where: { adminId, revokedAt: null, ...(sessionId ? { id: { not: sessionId } } : {}) }, data: { revokedAt: new Date() } });
  return { id: admin.id, email: admin.email, name: admin.name };
});
module.exports = { ROLE_PERMISSIONS, hashPassword, verifyPassword, ensureRoles, authenticate, verifyToken, hasPermission, createInvitation, acceptInvitation, revokeSessions, changeOwnPassword };
