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

// Current key version header
const CURRENT_VERSION = 'v1';

// Authenticated encryption (GCM): ciphertext formatted as `v1:iv:authTag:data`
const encrypt = (text, version = CURRENT_VERSION, key = ENCRYPTION_KEY) => {
  const iv = crypto.randomBytes(IV_LENGTH);
  const keyBuf = typeof key === 'string' ? Buffer.from(key, 'hex') : key;
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${version}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
};

const decryptGcm = (iv, authTag, data, key = ENCRYPTION_KEY) => {
  const keyBuf = typeof key === 'string' ? Buffer.from(key, 'hex') : key;
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
};

const decryptCbc = (iv, data, key = ENCRYPTION_KEY) => {
  const keyBuf = typeof key === 'string' ? Buffer.from(key, 'hex') : key;
  const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuf, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
};

const decrypt = (text, key = ENCRYPTION_KEY) => {
  const parts = text.split(':');
  if (parts.length === 4 && parts[0] === 'v1') {
    const [, iv, authTag, data] = parts;
    return decryptGcm(Buffer.from(iv, 'hex'), Buffer.from(authTag, 'hex'), Buffer.from(data, 'hex'), key);
  }
  if (parts.length === 3) {
    const [iv, authTag, data] = parts;
    return decryptGcm(Buffer.from(iv, 'hex'), Buffer.from(authTag, 'hex'), Buffer.from(data, 'hex'), key);
  }
  if (parts.length === 2) {
    const [iv, data] = parts;
    return decryptCbc(Buffer.from(iv, 'hex'), Buffer.from(data, 'hex'), key);
  }
  throw new Error('Malformed ciphertext: expected versioned/unversioned GCM or legacy CBC format');
};

const rotateCiphertext = (ciphertext, oldKey, newKey, newVersion = CURRENT_VERSION) => {
  const plaintext = decrypt(ciphertext, oldKey);
  return encrypt(plaintext, newVersion, newKey);
};

module.exports = {
  CURRENT_VERSION,
  encrypt,
  decrypt,
  rotateCiphertext,
};
