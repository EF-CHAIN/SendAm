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

const resetKmsProvider = () => {
  activeKmsProvider = defaultKmsProvider;
};

const getActiveKeyVersion = () => CURRENT_VERSION;

const ENVELOPE_PREFIX = 'env:v1:';
const DIRECT_KMS_PREFIX = 'kms:v1:';

const isEnvelopeCiphertext = (value) => (
  typeof value === 'string' && (value.startsWith(ENVELOPE_PREFIX) || value.startsWith(DIRECT_KMS_PREFIX))
);

/**
 * Parses a serialized envelope ciphertext (`env:v1:...` or `kms:v1:...`) into its structured metadata.
 */
const parseEnvelopeCiphertext = (serialized) => {
  if (typeof serialized !== 'string') {
    throw new Error('Envelope ciphertext must be a string.');
  }

  if (serialized.startsWith(DIRECT_KMS_PREFIX)) {
    const rest = serialized.slice(DIRECT_KMS_PREFIX.length);
    const firstSep = rest.indexOf(':');
    const secondSep = firstSep >= 0 ? rest.indexOf(':', firstSep + 1) : -1;
    const thirdSep = secondSep >= 0 ? rest.indexOf(':', secondSep + 1) : -1;
    if (firstSep < 0 || secondSep < 0 || thirdSep < 0) {
      throw new Error('Malformed direct KMS ciphertext.');
    }
    const provider = rest.slice(0, firstSep);
    const keyVersion = rest.slice(firstSep + 1, secondSep);
    const keyId = Buffer.from(rest.slice(secondSep + 1, thirdSep), 'base64url').toString('utf8');
    const ciphertext = rest.slice(thirdSep + 1);
    return { mode: 'direct', provider, keyVersion, keyId, ciphertext };
  }

  if (serialized.startsWith(ENVELOPE_PREFIX)) {
    const parts = serialized.slice(ENVELOPE_PREFIX.length).split(':');
    if (parts.length !== 7) {
      throw new Error('Malformed envelope ciphertext: expected 7 envelope segments.');
    }
    const [provider, keyVersion, keyIdB64, encryptedDataKeyB64, ivHex, authTagHex, dataHex] = parts;
    return {
      mode: 'envelope',
      provider,
      keyVersion,
      keyId: Buffer.from(keyIdB64, 'base64url').toString('utf8'),
      encryptedDataKey: Buffer.from(encryptedDataKeyB64, 'base64url').toString('utf8'),
      ivHex,
      authTagHex,
      dataHex,
    };
  }

  return null;
};

/**
 * Encrypts plaintext using the active KMS provider (AWS KMS envelope, Vault Transit, or local KMS).
 * Plaintext DEKs are zeroed in memory immediately after encryption.
 */
const encryptEnvelope = async (plaintext, {
  keyVersion = CURRENT_VERSION,
  keyId = null,
  encryptionContext = null,
  provider = activeKmsProvider,
  directTransit = false,
} = {}) => {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('Plaintext must be a non-empty string.');
  }

  if (directTransit && typeof provider.encrypt === 'function') {
    const result = await provider.encrypt({
      plaintext,
      keyName: keyId || undefined,
      context: encryptionContext,
    });
    const resolvedKeyId = result.keyName || keyId || 'default';
    const resolvedVersion = result.keyVersion || keyVersion;
    const serialized = `${DIRECT_KMS_PREFIX}${provider.name}:${resolvedVersion}:${Buffer.from(resolvedKeyId, 'utf8').toString('base64url')}:${result.ciphertext}`;
    return {
      mode: 'direct',
      provider: provider.name,
      keyVersion: resolvedVersion,
      keyId: resolvedKeyId,
      ciphertext: result.ciphertext,
      serialized,
    };
  }

  const dataKey = await provider.generateDataKey({
    keyVersion,
    keyId,
    encryptionContext,
  });

  const plaintextKey = Buffer.isBuffer(dataKey.plaintextKey)
    ? dataKey.plaintextKey
    : Buffer.from(dataKey.plaintextKey);

  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', plaintextKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const resolvedKeyId = String(dataKey.keyId || keyId || keyVersion);
    const resolvedVersion = String(dataKey.keyVersion || keyVersion);
    const encryptedDataKey = String(dataKey.encryptedDataKey);

    const serialized = [
      ENVELOPE_PREFIX.slice(0, -1),
      provider.name || 'kms',
      resolvedVersion,
      Buffer.from(resolvedKeyId, 'utf8').toString('base64url'),
      Buffer.from(encryptedDataKey, 'utf8').toString('base64url'),
      iv.toString('hex'),
      authTag.toString('hex'),
      encrypted.toString('hex'),
    ].join(':');

    return {
      mode: 'envelope',
      provider: provider.name || 'kms',
      keyVersion: resolvedVersion,
      keyId: resolvedKeyId,
      encryptedDataKey,
      ciphertext: `${resolvedVersion}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`,
      serialized,
    };
  } finally {
    // Only zero freshly generated remote DEKs; do not zero static local-kms cached keys.
    if (provider.name !== 'local-kms') {
      plaintextKey.fill(0);
    }
  }
};

/**
 * Decrypts an envelope ciphertext (serialized string or structured object) using the active KMS provider.
 * Transparently falls back to synchronous `decrypt()` for legacy local ciphertexts.
 */
const decryptEnvelope = async (envelopeOrCiphertext, {
  encryptionContext = null,
  provider = activeKmsProvider,
} = {}) => {
  if (typeof envelopeOrCiphertext === 'string' && !isEnvelopeCiphertext(envelopeOrCiphertext)) {
    return decrypt(envelopeOrCiphertext);
  }

  const parsed = typeof envelopeOrCiphertext === 'string'
    ? parseEnvelopeCiphertext(envelopeOrCiphertext)
    : envelopeOrCiphertext;

  if (!parsed) {
    throw new Error('Malformed envelope ciphertext.');
  }

  if (parsed.mode === 'direct') {
    if (typeof provider.decrypt !== 'function') {
      throw new Error(`Active KMS provider '${provider.name}' does not support direct decryption.`);
    }
    return provider.decrypt({
      ciphertext: parsed.ciphertext,
      keyName: parsed.keyId || undefined,
      context: encryptionContext,
    });
  }

  const plaintextKey = await provider.decryptDataKey({
    encryptedDataKey: parsed.encryptedDataKey,
    keyVersion: parsed.keyVersion,
    keyId: parsed.keyId,
    encryptionContext,
  });

  const keyBuf = Buffer.isBuffer(plaintextKey) ? plaintextKey : Buffer.from(plaintextKey);
  try {
    return decryptGcm(
      Buffer.from(parsed.ivHex, 'hex'),
      Buffer.from(parsed.authTagHex, 'hex'),
      Buffer.from(parsed.dataHex, 'hex'),
      keyBuf,
    );
  } finally {
    if (provider.name !== 'local-kms') {
      keyBuf.fill(0);
    }
  }
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
  getActiveKeyVersion,
  encrypt,
  decrypt,
  encryptEnvelope,
  decryptEnvelope,
  isEnvelopeCiphertext,
  parseEnvelopeCiphertext,
  rotateCiphertext,
  registerKeyVersion,
  setKmsProvider,
  resetKmsProvider,
  getKmsProvider: () => activeKmsProvider,
};
