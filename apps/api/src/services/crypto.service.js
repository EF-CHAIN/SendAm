const crypto = require('crypto');
const config = require('../config/env');

const IV_LENGTH = 12; // 96-bit nonce for AES-256-GCM

if (!config.encryptionKey || Buffer.from(config.encryptionKey, 'hex').length !== 32) {
  throw new Error('ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes). Generate one with: openssl rand -hex 32');
}

const DEFAULT_KEY_V1 = Buffer.from(config.encryptionKey, 'hex');
const CURRENT_VERSION = config.activeKeyVersion || 'v1';

// Key Registry mapping version identifier strings to 32-byte Buffers
const keysByVersion = new Map();
keysByVersion.set('v1', DEFAULT_KEY_V1);

if (config.kmsKeyVersions && typeof config.kmsKeyVersions === 'object') {
  for (const [ver, val] of Object.entries(config.kmsKeyVersions)) {
    if (typeof val === 'string' && Buffer.from(val, 'hex').length === 32) {
      keysByVersion.set(ver, Buffer.from(val, 'hex'));
    }
  }
}

/**
 * Register a key version at runtime (useful for dynamic rotation and KMS key loading).
 */
const registerKeyVersion = (version, keyHexOrBuf) => {
  const buf = typeof keyHexOrBuf === 'string' ? Buffer.from(keyHexOrBuf, 'hex') : keyHexOrBuf;
  if (!buf || buf.length !== 32) {
    throw new Error(`Key version ${version} must be a 32-byte key.`);
  }
  keysByVersion.set(version, buf);
};

/**
 * Local / KMS Envelope Provider Interface
 */
const defaultKmsProvider = {
  name: 'local-kms',
  generateDataKey: async ({ keyVersion = CURRENT_VERSION }) => {
    const keyBuf = keysByVersion.get(keyVersion) || DEFAULT_KEY_V1;
    return {
      plaintextKey: keyBuf,
      encryptedDataKey: keyVersion,
    };
  },
  decryptDataKey: async ({ keyVersion = CURRENT_VERSION, encryptedDataKey }) => {
    const targetVer = encryptedDataKey || keyVersion;
    const keyBuf = keysByVersion.get(targetVer) || keysByVersion.get(keyVersion) || DEFAULT_KEY_V1;
    return keyBuf;
  },
};

let activeKmsProvider = defaultKmsProvider;

const setKmsProvider = (provider) => {
  if (!provider || typeof provider.generateDataKey !== 'function' || typeof provider.decryptDataKey !== 'function') {
    throw new Error('Invalid KMS provider: must implement generateDataKey and decryptDataKey.');
  }
  activeKmsProvider = provider;
};

const resolveKey = (version, explicitKey) => {
  if (explicitKey) {
    return typeof explicitKey === 'string' ? Buffer.from(explicitKey, 'hex') : explicitKey;
  }
  if (keysByVersion.has(version)) {
    return keysByVersion.get(version);
  }
  return DEFAULT_KEY_V1;
};

// Authenticated encryption (GCM): ciphertext formatted as `version:iv:authTag:data`
const encrypt = (text, version = CURRENT_VERSION, key = null) => {
  const iv = crypto.randomBytes(IV_LENGTH);
  const keyBuf = resolveKey(version, key);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${version}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
};

const decryptGcm = (iv, authTag, data, keyBuf) => {
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
};

const decryptCbc = (iv, data, keyBuf) => {
  const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuf, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
};

const decrypt = (text, key = null) => {
  const parts = text.split(':');
  
  // Format: version:iv:authTag:data (e.g. v1:..., v2:...)
  if (parts.length === 4 && parts[0].length >= 2 && parts[0].startsWith('v')) {
    const [ver, iv, authTag, data] = parts;
    const keyBuf = resolveKey(ver, key);
    return decryptGcm(Buffer.from(iv, 'hex'), Buffer.from(authTag, 'hex'), Buffer.from(data, 'hex'), keyBuf);
  }

  // Format: iv:authTag:data (unversioned GCM)
  if (parts.length === 3) {
    const [iv, authTag, data] = parts;
    const keyBuf = resolveKey('v1', key);
    return decryptGcm(Buffer.from(iv, 'hex'), Buffer.from(authTag, 'hex'), Buffer.from(data, 'hex'), keyBuf);
  }

  // Format: iv:data (legacy CBC)
  if (parts.length === 2) {
    const [iv, data] = parts;
    const keyBuf = resolveKey('v1', key);
    return decryptCbc(Buffer.from(iv, 'hex'), Buffer.from(data, 'hex'), keyBuf);
  }

  throw new Error('Malformed ciphertext: expected versioned/unversioned GCM or legacy CBC format');
};

const rotateCiphertext = (ciphertext, oldKey = null, newKey = null, newVersion = CURRENT_VERSION) => {
  const plaintext = decrypt(ciphertext, oldKey);
  return encrypt(plaintext, newVersion, newKey);
};

module.exports = {
  CURRENT_VERSION,
  encrypt,
  decrypt,
  rotateCiphertext,
  registerKeyVersion,
  setKmsProvider,
  getKmsProvider: () => activeKmsProvider,
};
