const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { validateEnv } = require('../src/config/validateEnv');

const validKey = crypto.randomBytes(32).toString('hex');
const validSecret = crypto.randomBytes(32).toString('hex');

const baseConfig = () => ({
  isProduction: false,
  encryptionKey: validKey,
  admin: { jwtSecret: validSecret, password: 'correct horse battery staple' },
  whatsapp: { appSecret: undefined },
  messageTransport: 'meta',
});

test('valid config does not throw', () => {
  assert.doesNotThrow(() => validateEnv(baseConfig()));
});

test('missing ENCRYPTION_KEY throws', () => {
  const config = baseConfig();
  config.encryptionKey = undefined;
  assert.throws(() => validateEnv(config), /ENCRYPTION_KEY/);
});

test('short ENCRYPTION_KEY throws', () => {
  const config = baseConfig();
  config.encryptionKey = 'deadbeef';
  assert.throws(() => validateEnv(config), /ENCRYPTION_KEY/);
});

test('short JWT_SECRET throws', () => {
  const config = baseConfig();
  config.admin.jwtSecret = 'too-short';
  assert.throws(() => validateEnv(config), /JWT_SECRET/);
});

test('missing ADMIN_PASSWORD throws', () => {
  const config = baseConfig();
  config.admin.password = undefined;
  assert.throws(() => validateEnv(config), /ADMIN_PASSWORD/);
});

test('missing WHATSAPP_APP_SECRET is fine outside production', () => {
  const config = baseConfig();
  config.isProduction = false;
  config.whatsapp.appSecret = undefined;
  assert.doesNotThrow(() => validateEnv(config));
});

test('missing WHATSAPP_APP_SECRET throws in production', () => {
  const config = baseConfig();
  config.isProduction = true;
  config.whatsapp.appSecret = undefined;
  assert.throws(() => validateEnv(config), /WHATSAPP_APP_SECRET/);
});

test('multiple violations are all reported in one error', () => {
  const config = baseConfig();
  config.encryptionKey = undefined;
  config.admin.password = undefined;
  assert.throws(() => validateEnv(config), (err) => {
    assert.match(err.message, /ENCRYPTION_KEY/);
    assert.match(err.message, /ADMIN_PASSWORD/);
    return true;
  });
});

test('invalid MESSAGE_TRANSPORT throws', () => {
  const config = baseConfig();
  config.messageTransport = 'invalid';
  assert.throws(() => validateEnv(config), /MESSAGE_TRANSPORT/);
});

test('valid MESSAGE_TRANSPORT does not throw', () => {
  const config = baseConfig();
  config.messageTransport = 'sim';
  assert.doesNotThrow(() => validateEnv(config));
  
  config.messageTransport = 'meta';
  assert.doesNotThrow(() => validateEnv(config));
});
