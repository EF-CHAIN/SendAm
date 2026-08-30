const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// crypto.service validates the key at require-time, so set it before importing.
const KEY_HEX = 'a'.repeat(64); // 32 bytes
process.env.ENCRYPTION_KEY = KEY_HEX;

const { encrypt, decrypt, rotateCiphertext } = require('../src/services/crypto.service');

test('encrypt -> decrypt round-trips a Stellar secret', () => {
  const secret = 'SAEXAMPLESECRETKEYVALUE1234567890';
  const ciphertext = encrypt(secret);
  assert.equal(decrypt(ciphertext), secret);
});

test('ciphertext uses the v1:iv:authTag:data (GCM) form', () => {
  const parts = encrypt('hello').split(':');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'v1');
});

test('unversioned 3-part GCM ciphertexts still decrypt', () => {
  const iv = crypto.randomBytes(12);
  const key = Buffer.from(KEY_HEX, 'hex');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update('unversioned-gcm', 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const unversioned = `${iv.toString('hex')}:${authTag.toString('hex')}:${enc.toString('hex')}`;
  assert.equal(decrypt(unversioned), 'unversioned-gcm');
});

test('rotateCiphertext re-encrypts plaintext under a new key', () => {
  const oldKey = KEY_HEX;
  const newKey = 'b'.repeat(64);
  const ciphertext = encrypt('secret-key-data');
  const rotated = rotateCiphertext(ciphertext, oldKey, newKey);
  assert.notEqual(ciphertext, rotated);
  assert.equal(decrypt(rotated, newKey), 'secret-key-data');
});

test('two encryptions of the same plaintext differ (random IV)', () => {
  assert.notEqual(encrypt('same'), encrypt('same'));
});

test('tampering with the ciphertext is detected on decrypt (GCM auth)', () => {
  const [v, iv, authTag, data] = encrypt('move-funds').split(':');
  // Flip the last nibble of the data segment.
  const flipped = data.slice(0, -1) + (data.slice(-1) === '0' ? '1' : '0');
  assert.throws(() => decrypt(`${v}:${iv}:${authTag}:${flipped}`));
});

test('malformed ciphertext throws a clear error', () => {
  assert.throws(() => decrypt('not-a-valid-ciphertext'), /Malformed ciphertext/);
});

test('legacy aes-256-cbc (iv:data) ciphertexts still decrypt', () => {
  const key = Buffer.from(KEY_HEX, 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const enc = Buffer.concat([cipher.update('legacy-secret', 'utf8'), cipher.final()]);
  const legacy = `${iv.toString('hex')}:${enc.toString('hex')}`;
  assert.equal(decrypt(legacy), 'legacy-secret');
});
