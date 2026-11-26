const crypto = require('crypto');
const config = require('../config/env');
const logger = require('../utils/logger');
const { verifyPinAttempt, verifyPin } = require('../compliance/pin.service');

const TOKEN_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

function getSecretKey() {
  return config.encryptionKey || config.admin?.jwtSecret || 'sendam-pin-flow-secret';
}

/**
 * Generates a masked string of asterisks matching the PIN's length (default 4).
 * Raw PIN is never logged or exposed.
 */
function maskPin(pin) {
  if (!pin) return '****';
  const len = String(pin).trim().length;
  return '*'.repeat(len > 0 ? len : 4);
}

/**
 * Builds user security guidance prompting deletion of plaintext PIN from chat history.
 */
function buildPinSecurityGuidance(pin = '****') {
  const masked = maskPin(pin);
  return `🔒 PIN entered: ${masked}\n\n⚠️ Security Notice: For your account security, please delete your PIN message from this chat history immediately.`;
}

/**
 * Generates an ephemeral one-time web token for entering PIN securely in a browser.
 */
function generateEphemeralPinToken({ userId, stateId, expiresInMs = TOKEN_EXPIRY_MS }) {
  const expiresAt = Date.now() + expiresInMs;
  const payload = { userId, stateId, exp: expiresAt };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', getSecretKey())
    .update(payloadB64)
    .digest('base64url');
  return `${payloadB64}.${signature}`;
}

/**
 * Verifies an ephemeral web token and ensures it has not expired.
 */
function verifyEphemeralPinToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadB64, signature] = parts;
  const expectedSig = crypto
    .createHmac('sha256', getSecretKey())
    .update(payloadB64)
    .digest('base64url');

  if (signature !== expectedSig) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Generates web entry URL for secure PIN confirmation.
 */
function getWebPinEntryUrl(token) {
  const baseUrl = process.env.PIN_WEB_BASE_URL || process.env.APP_BASE_URL || 'https://sendam.app';
  return `${baseUrl.replace(/\/+$/, '')}/auth/pin?token=${token}`;
}

/**
 * Sends masked feedback and deletion guidance to user.
 */
async function sendMaskedPinFeedback({ notify, phoneNumber, pin }) {
  const msg = buildPinSecurityGuidance(pin);
  await notify(phoneNumber, msg);
}

/**
 * Processes PIN verification safely with masked logging and user deletion guidance.
 */
async function processPinVerification({
  prisma,
  user,
  rawPin,
  notify,
  phoneNumber,
}) {
  const masked = maskPin(rawPin);

  // Masked audit logging - never log rawPin
  logger.info('pin_verification_initiated', {
    userId: user.id,
    phoneNumber,
    maskedPin: masked,
  });

  // Provide immediate masked feedback and deletion guidance
  await sendMaskedPinFeedback({ notify, phoneNumber, pin: rawPin });

  const userWithPin = await prisma.user.findUnique({ where: { id: user.id } });
  let pinOk = false;

  if (typeof verifyPinAttempt === 'function' && userWithPin && userWithPin.pinFailedAttempts !== undefined) {
    const pinAttempt = await verifyPinAttempt({ prisma, userId: user.id, pin: rawPin });
    pinOk = pinAttempt.ok;
    if (!pinAttempt.ok && pinAttempt.locked) {
      const retrySeconds = Math.max(1, Math.ceil(pinAttempt.retryAfterMs / 1000));
      return {
        ok: false,
        locked: true,
        message: `PIN verification failed. Your account is temporarily locked. Please try again in ${retrySeconds} seconds, or reply "no" to cancel.`,
      };
    }
  } else {
    pinOk = verifyPin(rawPin, userWithPin?.pinHash);
  }

  return { ok: pinOk, locked: false };
}

module.exports = {
  maskPin,
  buildPinSecurityGuidance,
  generateEphemeralPinToken,
  verifyEphemeralPinToken,
  getWebPinEntryUrl,
  sendMaskedPinFeedback,
  processPinVerification,
};
