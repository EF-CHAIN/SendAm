// Unit tests for the canonical Stellar asset identity module (#285).
//
// The central guarantee: an asset is never identified by its code alone.
// Identity is always (network, code, issuer), and a same-code token from an
// unrecognized issuer (e.g. a spoofed "USDC") is never trusted or treated as
// the real asset — while still being fully describable for reconciliation.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const assetIdentity = require('../src/wallet/assetIdentity');

// Real configured issuer for USDC on each network (from network profiles).
const TESTNET_USDC = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const MAINNET_USDC = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const SPOOF_ISSUER = 'GAQAA5L65LSYH7CQ3VTJ7F3HHNTNCQIKEO7YPC2FUYAKQNRFAWSFTNZK';

test('native XLM has a stable network-qualified identity with no issuer and is always trusted', () => {
  const id = assetIdentity.describeAsset({
    network: 'testnet',
    assetType: 'native',
  });

  assert.equal(id.chain, 'stellar');
  assert.equal(id.network, 'testnet');
  assert.equal(id.code, 'XLM');
  assert.equal(id.issuer, null);
  assert.equal(id.assetId, 'stellar:testnet:XLM');
  assert.equal(id.trusted, true);
});

test('native identity is network-qualified — public and testnet differ', () => {
  const pub = assetIdentity.describeAsset({ network: 'public', assetType: 'native' });
  const test = assetIdentity.describeAsset({ network: 'testnet', assetType: 'native' });
  assert.notEqual(pub.assetId, test.assetId);
});

test('configured USDC on its configured issuer is trusted with full provenance', () => {
  const id = assetIdentity.describeAsset({
    network: 'testnet',
    assetType: 'credit_alphanum4',
    code: 'USDC',
    issuer: TESTNET_USDC,
  });

  assert.equal(id.issuer, TESTNET_USDC);
  assert.equal(id.assetId, `stellar:testnet:USDC:${TESTNET_USDC}`);
  assert.equal(id.trusted, true);
});

test('a spoofed USDC from a different issuer is never trusted, despite the code', () => {
  const id = assetIdentity.describeAsset({
    network: 'testnet',
    assetType: 'credit_alphanum4',
    code: 'USDC',
    issuer: SPOOF_ISSUER,
  });

  assert.equal(id.code, 'USDC');
  assert.equal(id.trusted, false);
  assert.equal(id.assetId, `stellar:testnet:USDC:${SPOOF_ISSUER}`);
});

test('unknown assets are never trusted and keep a stable identity', () => {
  const id = assetIdentity.describeAsset({
    network: 'testnet',
    assetType: 'credit_alphanum4',
    code: 'DOGE',
    issuer: SPOOF_ISSUER,
  });

  assert.equal(id.code, 'DOGE');
  assert.equal(id.trusted, false);
  assert.equal(id.assetId, `stellar:testnet:DOGE:${SPOOF_ISSUER}`);
});

test('an asset with no issuer (missing provenance) is never trusted', () => {
  const id = assetIdentity.describeAsset({
    network: 'testnet',
    assetType: 'credit_alphanum4',
    code: 'USDC',
    issuer: null,
  });

  assert.equal(id.trusted, false);
});

test('issuer trust is per-network — mainnet issuer is not trusted on testnet', () => {
  // An issuer that is correct on mainnet must not be trusted on testnet.
  const id = assetIdentity.describeAsset({
    network: 'testnet',
    assetType: 'credit_alphanum4',
    code: 'USDC',
    issuer: MAINNET_USDC,
  });

  assert.equal(id.trusted, false);
  assert.equal(id.issuer, MAINNET_USDC);
});

test('canonicalAssetKey is stable and distinguishes issuer changes', () => {
  const a = assetIdentity.canonicalAssetKey({ network: 'testnet', code: 'USDC', issuer: TESTNET_USDC });
  const b = assetIdentity.canonicalAssetKey({ network: 'testnet', code: 'USDC', issuer: SPOOF_ISSUER });
  const xlm = assetIdentity.canonicalAssetKey({ network: 'testnet', code: 'XLM', issuer: null });

  assert.equal(a, `stellar:testnet:USDC:${TESTNET_USDC}`);
  assert.notEqual(a, b);
  assert.equal(xlm, 'stellar:testnet:XLM');
});

test('isTrustedIssuedAsset requires an exact issuer match for recognized codes', () => {
  assert.equal(
    assetIdentity.isTrustedIssuedAsset({ network: 'testnet', code: 'USDC', issuer: TESTNET_USDC }),
    true,
  );
  assert.equal(
    assetIdentity.isTrustedIssuedAsset({ network: 'testnet', code: 'USDC', issuer: SPOOF_ISSUER }),
    false,
  );
  assert.equal(
    assetIdentity.isTrustedIssuedAsset({ network: 'testnet', code: 'DOGE', issuer: SPOOF_ISSUER }),
    false,
  );
});

test('resolveConfiguredIssuer returns the configured issuer for a recognized code, else null', () => {
  assert.equal(
    assetIdentity.resolveConfiguredIssuer({ network: 'testnet', code: 'USDC' }),
    TESTNET_USDC,
  );
  assert.equal(assetIdentity.resolveConfiguredIssuer({ network: 'testnet', code: 'XLM' }), null);
  assert.equal(assetIdentity.resolveConfiguredIssuer({ network: 'testnet', code: 'DOGE' }), null);
  assert.equal(assetIdentity.resolveConfiguredIssuer({ network: 'testnet', code: 'native' }), null);
});
