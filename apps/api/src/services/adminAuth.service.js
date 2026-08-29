const crypto = require('crypto');
const config = require('../config/env');

// Real backend admin auth, replacing the old frontend-only mock login.
// Tokens are HMAC-SHA256 signed with JWT_SECRET (no external dependency) and
// carry an expiry. Like crypto.service, secrets must be present and fail loud
// rather than fall back to a guessable default that would leave the admin API
// effectively open.
if (!config.admin.jwtSecret || config.admin.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be set to a strong secret (>= 32 chars). Generate one with: openssl rand -hex 32');
}
if (!config.admin.password) {
  throw new Error('ADMIN_PASSWORD must be set to enable admin login.');
}

const JWT_SECRET = config.admin.jwtSecret;
const ADMIN_PASSWORD = config.admin.password;
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

const verifyPassword = (candidate) => {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  return safeEqual(candidate, ADMIN_PASSWORD);
};

const createToken = () => {
  const payload = { role: 'admin', permissions: ADMIN_PERMISSIONS, iat: Date.now(), exp: Date.now() + TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
};

const verifyToken = (token) => {
  if (typeof token !== 'string') return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;

  if (!safeEqual(signature, sign(body))) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }

  if (payload.role !== 'admin') return null;
  if (!payload.exp || Date.now() > payload.exp) return null;

  return payload;
};

module.exports = {
  ADMIN_PERMISSIONS,
  verifyPassword,
  createToken,
  verifyToken,
};
