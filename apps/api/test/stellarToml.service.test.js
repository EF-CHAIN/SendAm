const { test } = require('node:test');
const assert = require('node:assert/strict');
const toml = require('toml');
const { StellarSdk } = require('../src/config/stellar');
const {
  getStellarTomlData,
  serializeToml,
  validateStellarToml,
  getStellarTomlContent,
  resolveSigningKey,
  resolveEndpoints,
  buildCurrencies,
  STELLAR_TOML_MAX_SIZE,
} = require('../src/services/stellarToml.service');

test('resolveEndpoints derives URLs correctly with defaults and requests', () => {
  const endpoints = resolveEndpoints();
  assert.ok(endpoints.homeDomain);
  assert.ok(endpoints.webAuthDomain);
  assert.ok(endpoints.webAuthEndpoint.includes('/api/auth'));
  assert.ok(endpoints.federationServer.includes('/api/federation'));
  assert.ok(endpoints.horizonUrl);

  const mockReq = {
    get: (header) => (header === 'host' ? 'custom.sendam.app' : null),
    protocol: 'https',
  };
  const reqEndpoints = resolveEndpoints(mockReq);
  assert.equal(reqEndpoints.webAuthEndpoint, 'https://custom.sendam.app/api/auth');
});

test('resolveSigningKey returns valid Stellar Ed25519 public key', () => {
  const key = resolveSigningKey();
  assert.ok(typeof key === 'string');
  assert.equal(StellarSdk.StrKey.isValidEd25519PublicKey(key), true);
});

test('resolveSigningKey derives public key from secret seed when provided', () => {
  const testKeypair = StellarSdk.Keypair.random();
  const origKey = process.env.STELLAR_AUTH_SIGNING_KEY;
  const origExplicit = process.env.STELLAR_SIGNING_KEY;
  delete process.env.STELLAR_SIGNING_KEY;

  try {
    process.env.STELLAR_AUTH_SIGNING_KEY = testKeypair.secret();
    const resolved = resolveSigningKey();
    assert.equal(resolved, testKeypair.publicKey());
  } finally {
    if (origKey !== undefined) process.env.STELLAR_AUTH_SIGNING_KEY = origKey;
    else delete process.env.STELLAR_AUTH_SIGNING_KEY;
    if (origExplicit !== undefined) process.env.STELLAR_SIGNING_KEY = origExplicit;
  }
});

test('buildCurrencies declares both USDC and XLM with proper specifications', () => {
  const currencies = buildCurrencies();
  assert.ok(Array.isArray(currencies));
  assert.ok(currencies.length >= 2);

  const usdc = currencies.find((c) => c.code === 'USDC');
  assert.ok(usdc);
  assert.equal(StellarSdk.StrKey.isValidEd25519PublicKey(usdc.issuer), true);
  assert.equal(usdc.display_decimals, 7);
  assert.equal(usdc.is_asset_anchored, true);
  assert.equal(usdc.anchor_asset_type, 'fiat');
  assert.equal(usdc.anchor_asset, 'USD');

  const xlm = currencies.find((c) => c.code === 'XLM');
  assert.ok(xlm);
  assert.equal(xlm.display_decimals, 7);
  assert.equal(xlm.is_asset_anchored, false);
});

test('getStellarTomlData constructs complete SEP-1 data structure', () => {
  const data = getStellarTomlData();
  assert.equal(data.VERSION, '2.0.0');
  assert.ok(data.NETWORK_PASSPHRASE);
  assert.ok(data.SIGNING_KEY);
  assert.ok(data.WEB_AUTH_ENDPOINT);
  assert.ok(data.DOCUMENTATION);
  assert.equal(data.DOCUMENTATION.ORG_NAME, 'SendAm');
  assert.ok(Array.isArray(data.CURRENCIES));
});

test('serializeToml produces valid TOML that round-trips via toml.parse', () => {
  const data = getStellarTomlData();
  const serialized = serializeToml(data);

  assert.ok(typeof serialized === 'string');
  assert.match(serialized, /NETWORK_PASSPHRASE\s*=/);
  assert.match(serialized, /SIGNING_KEY\s*=/);
  assert.match(serialized, /WEB_AUTH_ENDPOINT\s*=/);
  assert.match(serialized, /\[\[CURRENCIES\]\]/);

  const parsed = toml.parse(serialized);
  assert.equal(parsed.VERSION, data.VERSION);
  assert.equal(parsed.NETWORK_PASSPHRASE, data.NETWORK_PASSPHRASE);
  assert.equal(parsed.SIGNING_KEY, data.SIGNING_KEY);
  assert.equal(parsed.WEB_AUTH_ENDPOINT, data.WEB_AUTH_ENDPOINT);
  assert.equal(parsed.CURRENCIES.length, data.CURRENCIES.length);
  assert.equal(parsed.CURRENCIES[0].code, data.CURRENCIES[0].code);
});

test('validateStellarToml passes for dynamically generated content', () => {
  const content = getStellarTomlContent();
  const validation = validateStellarToml(content);

  assert.equal(validation.valid, true);
  assert.equal(validation.errors.length, 0);
  assert.ok(validation.summary.networkPassphrase);
  assert.ok(validation.summary.signingKey);
  assert.ok(validation.summary.webAuthEndpoint);
  assert.ok(validation.summary.currencies.includes('USDC'));
  assert.ok(validation.summary.currencies.includes('XLM'));
});

test('validateStellarToml flags errors for missing required fields', () => {
  const badToml = 'VERSION = "2.0.0"\n';
  const validation = validateStellarToml(badToml);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.includes('NETWORK_PASSPHRASE')));
  assert.ok(validation.errors.some((e) => e.includes('SIGNING_KEY')));
  assert.ok(validation.errors.some((e) => e.includes('WEB_AUTH_ENDPOINT')));
  assert.ok(validation.errors.some((e) => e.includes('CURRENCIES')));
});

test('validateStellarToml rejects invalid public key for SIGNING_KEY', () => {
  const badKeyToml = [
    'NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"',
    'WEB_AUTH_ENDPOINT = "https://api.sendam.app/api/auth"',
    'SIGNING_KEY = "NOT_A_VALID_STELLAR_KEY"',
    '[[CURRENCIES]]',
    'code = "XLM"',
  ].join('\n');

  const validation = validateStellarToml(badKeyToml);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.includes('SIGNING_KEY must be a valid Stellar Ed25519 public key')));
});

test('validateStellarToml rejects non-XLM currency without valid issuer', () => {
  const badCurrencyToml = [
    'NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"',
    'WEB_AUTH_ENDPOINT = "https://api.sendam.app/api/auth"',
    'SIGNING_KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"',
    '[[CURRENCIES]]',
    'code = "USDC"',
    'issuer = "INVALID_ISSUER"',
  ].join('\n');

  const validation = validateStellarToml(badCurrencyToml);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.includes('issuer must be a valid Stellar public key')));
});

test('validateStellarToml rejects malformed TOML syntax', () => {
  const invalidSyntax = 'KEY = = = BROKEN';
  const validation = validateStellarToml(invalidSyntax);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.includes('TOML syntax error')));
});

test('validateStellarToml rejects payloads exceeding maximum size', () => {
  const oversized = 'VERSION = "2.0.0"\n' + 'A'.repeat(STELLAR_TOML_MAX_SIZE + 10);
  const validation = validateStellarToml(oversized);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.includes('exceeds maximum allowed size')));
});
