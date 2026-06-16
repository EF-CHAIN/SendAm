const crypto = require('crypto');
const config = require('../config/env');

const IV_LENGTH = 12; // 96-bit nonce, the recommended size for GCM
// aes-256-gcm needs a 32-byte key. ENCRYPTION_KEY must be a 64-char hex
// string. No fallback: a missing/short key must fail loudly rather than
// silently encrypt wallet secrets with a guessable default.
if (!config.encryptionKey || Buffer.from(config.encryptionKey, 'hex').length !== 32) {
  throw new Error('ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes). Generate one with: openssl rand -hex 32');
}
const ENCRYPTION_KEY = Buffer.from(config.encryptionKey, 'hex');

// Authenticated encryption (GCM): tampering with the ciphertext is detected on
// decrypt instead of silently producing garbage, as the old unauthenticated
// CBC scheme did. New ciphertexts use the 3-part `iv:authTag:data` form.
const encrypt = (text) => {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
};

const decryptGcm = (iv, authTag, data) => {
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
};

// Legacy reader for secrets written by the old aes-256-cbc scheme (2-part
// `iv:data`). Kept so wallets created before the GCM switch still decrypt;
// remove once all stored secrets have been re-encrypted.
const decryptCbc = (iv, data) => {
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
};

const decrypt = (text) => {
  const parts = text.split(':');
  if (parts.length === 3) {
    const [iv, authTag, data] = parts;
    return decryptGcm(Buffer.from(iv, 'hex'), Buffer.from(authTag, 'hex'), Buffer.from(data, 'hex'));
  }
  if (parts.length === 2) {
    const [iv, data] = parts;
    return decryptCbc(Buffer.from(iv, 'hex'), Buffer.from(data, 'hex'));
  }
  throw new Error('Malformed ciphertext: expected iv:authTag:data or legacy iv:data');
};

module.exports = {
  encrypt,
  decrypt
};
