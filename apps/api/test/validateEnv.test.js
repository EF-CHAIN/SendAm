const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { validateEnv, validateWorkerEnv } = require('../src/config/validateEnv');

const validKey = crypto.randomBytes(32).toString('hex');
const validSecret = crypto.randomBytes(32).toString('hex');

const baseConfig = () => ({
  isProduction: false,
  encryptionKey: validKey,
  admin: { jwtSecret: validSecret, password: 'correct horse battery staple' },
  whatsapp: { appSecret: undefined },
  messageTransport: 'meta',
  stellar: {
    network: 'testnet',
    isMainnet: false,
    usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  },
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
  config.compliance = { pinPepper: 'pepper' };
  config.whatsapp.appSecret = undefined;
  assert.throws(() => validateEnv(config), /WHATSAPP_APP_SECRET/);
});

test('missing PIN_PEPPER throws in production', () => {
  const config = baseConfig();
  config.isProduction = true;
  config.whatsapp.appSecret = 'secret';
  config.compliance = { pinPepper: undefined };
  assert.throws(() => validateEnv(config), /PIN_PEPPER/);
});

test('production Meta transport requires complete webhook configuration', () => {
  const config = baseConfig();
  config.isProduction = true;
  config.messageTransport = 'meta';
  config.whatsapp = { appSecret: 'app-secret' };
  config.compliance = { pinPepper: 'pepper' };
  assert.throws(() => validateEnv(config), /WHATSAPP_VERIFY_TOKEN/);

  config.whatsapp = {
    token: 'system-user-token',
    phoneNumberId: 'phone-id',
    verifyToken: 'verify-token-at-least-32-characters',
    appSecret: 'app-secret',
    callbackUrl: 'https://api.example.com/webhook',
    businessAccountId: 'waba-id',
    graphApiVersion: 'v99.0',
  };
  assert.doesNotThrow(() => validateEnv(config));
});

test('production WhatsApp callback URL must use HTTPS', () => {
  const config = baseConfig();
  config.isProduction = true;
  config.messageTransport = 'meta';
  config.whatsapp = {
    token: 'system-user-token',
    phoneNumberId: 'phone-id',
    verifyToken: 'verify-token-at-least-32-characters',
    appSecret: 'app-secret',
    callbackUrl: 'http://api.example.com/webhook',
    businessAccountId: 'waba-id',
    graphApiVersion: 'v99.0',
  };
  config.compliance = { pinPepper: 'pepper' };
  assert.throws(() => validateEnv(config), /must use HTTPS/);
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

test('mainnet with testnet USDC issuer throws', () => {
  const config = baseConfig();
  config.stellar.isMainnet = true;
  config.stellar.usdcIssuer = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  assert.throws(() => validateEnv(config), /STELLAR_USDC_ISSUER.*must not be the Testnet issuer/);
});

test('mainnet with mainnet USDC issuer does not throw', () => {
  const config = baseConfig();
  config.stellar.isMainnet = true;
  config.stellar.usdcIssuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  assert.doesNotThrow(() => validateEnv(config));
});

test('testnet with testnet USDC issuer does not throw', () => {
  const config = baseConfig();
  config.stellar.isMainnet = false;
  config.stellar.usdcIssuer = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  assert.doesNotThrow(() => validateEnv(config));
});

test('worker requires Redis and valid concurrency settings', () => {
  assert.throws(
    () => validateWorkerEnv({ redis: {}, worker: { concurrency: 5, lockDurationMs: 30000 } }),
    /REDIS_URL/,
  );
  assert.throws(
    () => validateWorkerEnv({ redis: { url: 'redis://localhost' }, worker: { concurrency: 0, lockDurationMs: 30000 } }),
    /WORKER_CONCURRENCY/,
  );
  assert.doesNotThrow(
    () => validateWorkerEnv({ redis: { url: 'redis://localhost' }, worker: { concurrency: 5, lockDurationMs: 30000 } }),
  );
});
