const crypto = require('crypto');
const config = require('../config/env');

const IV_LENGTH = 16;
// Need to ensure the key is 32 bytes for aes-256-cbc.
// We expect a 64 char hex string from the environment variable ENCRYPTION_KEY,
// which we parse as a buffer of 32 bytes.
const ENCRYPTION_KEY = Buffer.from(config.encryptionKey || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');

const encrypt = (text) => {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
};

const decrypt = (text) => {
  const textParts = text.split(':');
  const iv = Buffer.from(textParts.shift(), 'hex');
  const encryptedText = Buffer.from(textParts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
};

module.exports = {
  encrypt,
  decrypt
};
