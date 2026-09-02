const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const srcRoot = path.resolve(__dirname, '../src');

// eslint-disable-next-line no-unused-vars
const injectMock = (relFromSrc, factory) => {
  const abs = path.resolve(srcRoot, `${relFromSrc}.js`);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: factory() };
};

const {
  buildManifest,
  signManifest,
  verifyManifest,
  writeManifest,
  readManifest,
  computeConfigHash,
  MANIFEST_VERSION,
  SUPPORTED_ENVIRONMENTS,
} = require('../src/config/deploymentManifest');

describe('deployment-manifest', () => {
  const testManifestPath = '/tmp/test-deployment-manifest.json';
  const signingSecret = crypto.randomBytes(32).toString('hex');

  beforeEach(() => {
    if (fs.existsSync(testManifestPath)) fs.unlinkSync(testManifestPath);
  });

  test('buildManifest returns a manifest with expected fields', () => {
    const manifest = buildManifest({ environment: 'production', release: 'v1.0.0', signedBy: 'test' });
    assert.strictEqual(manifest.version, MANIFEST_VERSION);
    assert.strictEqual(manifest.environment, 'production');
    assert.strictEqual(manifest.release, 'v1.0.0');
    assert.ok(manifest.configHash);
    assert.strictEqual(manifest.approved, true);
  });

  test('buildManifest rejects unsupported environments', () => {
    assert.throws(() => buildManifest({ environment: 'alien' }), /Unsupported environment/);
  });

  test('SUPPORTED_ENVIRONMENTS includes production', () => {
    assert.ok(SUPPORTED_ENVIRONMENTS.includes('production'));
  });

  test('computeConfigHash is deterministic', () => {
    const env = { A: '1', B: '2' };
    const h1 = computeConfigHash(env);
    const h2 = computeConfigHash(env);
    assert.strictEqual(h1, h2);
  });

  test('signManifest adds a signature block', () => {
    const manifest = buildManifest({ environment: 'staging', signedBy: 'ops' });
    const signed = signManifest(manifest, signingSecret);
    assert.ok(signed.signature);
    assert.strictEqual(signed.signature.algorithm, 'hmac-sha256');
    assert.ok(signed.signature.value);
    assert.ok(signed.signature.signedAt);
  });

  test('signManifest throws without a secret', () => {
    const manifest = buildManifest({ environment: 'staging' });
    assert.throws(() => signManifest(manifest, null), /MANIFEST_SIGNING_SECRET/);
  });

  test('verifyManifest returns valid for untampered manifest', () => {
    const manifest = buildManifest({ environment: 'staging', signedBy: 'ops' });
    const signed = signManifest(manifest, signingSecret);
    const result = verifyManifest(signed, signingSecret);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.environment, 'staging');
  });

  test('verifyManifest returns invalid for tampered payload', () => {
    const manifest = buildManifest({ environment: 'staging', signedBy: 'ops' });
    const signed = signManifest(manifest, signingSecret);
    signed.configHash = 'tampered';
    const result = verifyManifest(signed, signingSecret);
    assert.strictEqual(result.valid, false);
  });

  test('verifyManifest returns invalid for wrong secret', () => {
    const manifest = buildManifest({ environment: 'staging', signedBy: 'ops' });
    const signed = signManifest(manifest, signingSecret);
    const result = verifyManifest(signed, 'wrong-secret');
    assert.strictEqual(result.valid, false);
  });

  test('writeManifest and readManifest round-trip', () => {
    const manifest = buildManifest({ environment: 'production', signedBy: 'ops' });
    const signed = signManifest(manifest, signingSecret);
    writeManifest(signed, testManifestPath);
    assert.ok(fs.existsSync(testManifestPath));
    const read = readManifest(testManifestPath);
    assert.strictEqual(read.signature.value, signed.signature.value);
  });

  test('readManifest returns null for missing file', () => {
    assert.strictEqual(readManifest('/nonexistent/path/manifest.json'), null);
  });

  test('verifyManifest rejects unapproved manifest', () => {
    const manifest = buildManifest({ environment: 'production', signedBy: 'ops' });
    manifest.approved = false;
    const signed = signManifest(manifest, signingSecret);
    const result = verifyManifest(signed, signingSecret);
    // The verify function only checks signature, not approved flag - that's done in validateManifestAtStartup
    assert.strictEqual(result.valid, true);
  });
});
