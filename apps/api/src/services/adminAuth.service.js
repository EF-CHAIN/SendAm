const crypto = require('crypto');
const { promisify } = require('util');
const prisma = require('../common/prisma');
const config = require('../config/env');
const scrypt = promisify(crypto.scrypt);
const TTL_MS = config.admin.sessionTtlHours * 60 * 60 * 1000;
const ROLE_PERMISSIONS = Object.freeze({
  read_only: ['admin.read'],
  compliance: ['admin.read', 'compliance.read', 'compliance.write'],
  operations: ['admin.read', 'operations.write'],
  administrator: ['*'],
});
const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const hashPassword = async (password) => {
  if (typeof password !== 'string' || password.length < 12) throw Object.assign(new Error('Password must be at least 12 characters'), { statusCode: 400 });
  const salt = crypto.randomBytes(16); const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
};
const verifyPassword = async (candidate, encoded) => {
  if (typeof candidate !== 'string' || !encoded) return false;
  const [algorithm, saltText, hashText] = encoded.split('$');
  if (algorithm !== 'scrypt' || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, 'base64url');
  const actual = await scrypt(candidate, Buffer.from(saltText, 'base64url'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
};
const ensureRoles = () => prisma.$transaction(Object.entries(ROLE_PERMISSIONS).map(([name, permissions]) => prisma.adminRole.upsert({
  where: { name }, create: { name, permissions, description: `${name.replace('_', ' ')} administrator role` }, update: { permissions },
})));
const bootstrapLegacyAdministrator = async (email, password) => {
  if (!config.admin.password || !config.admin.bootstrapEmail || normalizeEmail(email) !== normalizeEmail(config.admin.bootstrapEmail)) return null;
  const candidate = Buffer.from(String(password || '')); const legacy = Buffer.from(config.admin.password);
  if (candidate.length !== legacy.length || !crypto.timingSafeEqual(candidate, legacy) || await prisma.adminUser.count() !== 0) return null;
  const roles = await ensureRoles(); const role = roles.find((item) => item.name === 'administrator');
  // The bootstrap account is minted from the shared ADMIN_PASSWORD, so it is
  // born with `mustChangePassword`. Until the operator rotates it to a private
  // password every admin route (except the password change itself) is blocked,
  // which keeps the shared credential from authenticating real admin work.
  return prisma.adminUser.create({ data: { email: normalizeEmail(email), name: 'Bootstrap administrator', passwordHash: await hashPassword(password), roleId: role.id, mustChangePassword: true }, include: { role: true } });
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
const verifyToken = async (token) => {
  if (typeof token !== 'string' || token.length < 32) return null;
  const session = await prisma.adminSession.findUnique({ where: { tokenHash: tokenHash(token) }, include: { admin: { include: { role: true } } } });
  if (!session || session.revokedAt || session.expiresAt <= new Date() || session.admin.disabledAt) return null;
  await prisma.adminSession.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } });
  return { id: session.admin.id, email: session.admin.email, name: session.admin.name, role: session.admin.role.name, permissions: session.admin.role.permissions, sessionId: session.id, mustChangePassword: session.admin.mustChangePassword === true };
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
