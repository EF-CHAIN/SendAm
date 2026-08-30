const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const {
  SUPPORTED_NETWORK_IDS,
  TESTNET_USDC_ISSUER,
  MAINNET_USDC_ISSUER,
  normalizeNetworkId,
  getNetworkProfile,
  resolveNetworkProfile,
  assertNetworkProfile,
  describeNetworkProfile,
  isAccountStrkey,
} = require('../src/config/networkProfiles');

const mainnetOk = {
  network: 'mainnet',
  allowMainnet: true,
  horizonUrl: 'https://horizon.stellar.org',
  usdcIssuer: MAINNET_USDC_ISSUER,
};

test('normalizeNetworkId accepts documented aliases only', () => {
  assert.equal(normalizeNetworkId('testnet'), 'testnet');
  assert.equal(normalizeNetworkId('TESTNET'), 'testnet');
  assert.equal(normalizeNetworkId(' mainnet '), 'public');
  assert.equal(normalizeNetworkId('pubnet'), 'public');
  assert.equal(normalizeNetworkId('public'), 'public');
});

test('normalizeNetworkId rejects typos and non-strings', () => {
  // The exact failure from #284: `testent` previously selected mainnet.
  assert.equal(normalizeNetworkId('testent'), null);
  assert.equal(normalizeNetworkId('mainet'), null);
  assert.equal(normalizeNetworkId(''), null);
  assert.equal(normalizeNetworkId(undefined), null);
  assert.equal(normalizeNetworkId(42), null);
});

test('a typo is rejected outright rather than resolving to a network', () => {
  const { profile, problems } = resolveNetworkProfile({ network: 'testent' });
  assert.equal(profile, null);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /STELLAR_NETWORK must be one of/);
  SUPPORTED_NETWORK_IDS.forEach((id) => assert.match(problems[0], new RegExp(id)));
});

test('testnet resolves cleanly with its own defaults', () => {
  const { profile, problems } = resolveNetworkProfile({ network: 'testnet' });
  assert.deepEqual(problems, []);
  assert.equal(profile.id, 'testnet');
  assert.equal(profile.isMainnet, false);
  assert.equal(profile.passphrase, 'Test SDF Network ; September 2015');
  assert.equal(profile.supportsFriendbot, true);
});

test('mainnet requires an explicit confirmation control', () => {
  const withoutConfirmation = resolveNetworkProfile({
    network: 'mainnet',
    horizonUrl: 'https://horizon.stellar.org',
    usdcIssuer: MAINNET_USDC_ISSUER,
  });
  assert.equal(withoutConfirmation.problems.length, 1);
  assert.match(withoutConfirmation.problems[0], /STELLAR_ALLOW_MAINNET=true/);

  assert.deepEqual(resolveNetworkProfile(mainnetOk).problems, []);
});

test('a Horizon endpoint from another network is rejected', () => {
  const { problems } = resolveNetworkProfile({
    ...mainnetOk,
    horizonUrl: 'https://horizon-testnet.stellar.org',
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not belong to Stellar Public Network/);
});

test('every failover Horizon URL is checked, not just the primary', () => {
  const { problems } = resolveNetworkProfile({
    ...mainnetOk,
    horizonUrls: ['https://horizon-testnet.stellar.org'],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not belong to/);
});

test('a malformed Horizon URL is reported as such', () => {
  const { problems } = resolveNetworkProfile({ network: 'testnet', horizonUrl: 'not a url' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /is not a valid URL/);
});

test('mainnet Horizon must use HTTPS', () => {
  const { problems } = resolveNetworkProfile({
    ...mainnetOk,
    horizonUrl: 'http://horizon.stellar.org',
  });
  assert.ok(problems.some((p) => /must use HTTPS/.test(p)));
});

test('the testnet USDC issuer is refused on mainnet, and named as such', () => {
  const { problems } = resolveNetworkProfile({ ...mainnetOk, usdcIssuer: TESTNET_USDC_ISSUER });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /That is the Testnet issuer/);
});

test('the mainnet USDC issuer is refused on testnet', () => {
  const { problems } = resolveNetworkProfile({ network: 'testnet', usdcIssuer: MAINNET_USDC_ISSUER });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /That is the mainnet issuer/);
});

test('a malformed issuer is rejected before it is compared', () => {
  // Contains `1`, which is not in the base32 strkey alphabet.
  const bad = 'GBBD47IF6LWK7P7MDEVNCWR7DPUWV3NY3DT1QEVFL4NAT4AQ3HZLLFLA5';
  const { problems } = resolveNetworkProfile({ network: 'testnet', usdcIssuer: bad });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /is not a valid Stellar account address/);
});

test('isAccountStrkey enforces the strkey shape', () => {
  assert.equal(isAccountStrkey(TESTNET_USDC_ISSUER), true);
  assert.equal(isAccountStrkey(MAINNET_USDC_ISSUER), true);
  assert.equal(isAccountStrkey(`G${'A'.repeat(54)}`), false); // too short
  assert.equal(isAccountStrkey(`C${'A'.repeat(55)}`), false); // contract, not account
  assert.equal(isAccountStrkey(`G${'1'.repeat(55)}`), false); // not base32
  assert.equal(isAccountStrkey(null), false);
});

test('Friendbot cannot be enabled under a mainnet profile', () => {
  const { problems } = resolveNetworkProfile({ ...mainnetOk, enableFriendbot: true });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Friendbot funding is not available/);

  assert.deepEqual(
    resolveNetworkProfile({ network: 'testnet', enableFriendbot: true }).problems,
    [],
  );
});

test('every inconsistency is reported at once, not one per restart', () => {
  const { problems } = resolveNetworkProfile({
    network: 'mainnet',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    usdcIssuer: TESTNET_USDC_ISSUER,
    enableFriendbot: true,
  });
  assert.equal(problems.length, 4);
});

test('assertNetworkProfile throws on an inconsistent bundle and returns a valid one', () => {
  assert.throws(
    () => assertNetworkProfile({ network: 'testent' }),
    /Invalid Stellar network configuration/,
  );
  assert.equal(assertNetworkProfile(mainnetOk).id, 'public');
});

test('getNetworkProfile returns null for an unknown id', () => {
  assert.equal(getNetworkProfile('nope'), null);
  assert.equal(getNetworkProfile('testnet').id, 'testnet');
});

test('describeNetworkProfile exposes identifiers but no secrets', () => {
  const described = describeNetworkProfile(getNetworkProfile('public'));
  assert.equal(described.network, 'public');
  assert.equal(described.isMainnet, true);
  assert.equal(described.usdcIssuer, MAINNET_USDC_ISSUER);
  const serialized = JSON.stringify(described).toLowerCase();
  ['secret', 'token', 'password', 'signingkey', 'privatekey'].forEach((forbidden) => {
    assert.equal(serialized.includes(forbidden), false, `must not expose ${forbidden}`);
  });
});

test('describeNetworkProfile is safe for an unresolved network', () => {
  assert.deepEqual(describeNetworkProfile(null), { network: 'unresolved', isMainnet: false });
});

// env.js caches its resolution at require time, so each case runs in a fresh
// process with only the environment changed.
const loadEnv = (env) => {
  const script = "const c = require('./src/config/env');"
    + 'process.stdout.write(JSON.stringify({'
    + 'network: c.stellar.network, isMainnet: c.stellar.isMainnet,'
    + 'problems: c.stellar.networkProblems.length, passphrase: c.stellar.networkPassphrase,'
    + 'issuer: c.stellar.usdcIssuer }));';
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return JSON.parse(out);
};

test('env.js fails closed: an unrecognised network is never treated as mainnet', () => {
  const result = loadEnv({ STELLAR_NETWORK: 'testent', STELLAR_ALLOW_MAINNET: '' });
  // Before #284 this selected the public network passphrase.
  assert.equal(result.isMainnet, false);
  assert.equal(result.problems, 1);
});

test('env.js resolves a confirmed mainnet deployment', () => {
  const result = loadEnv({
    STELLAR_NETWORK: 'mainnet',
    STELLAR_ALLOW_MAINNET: 'true',
    STELLAR_HORIZON_URL: 'https://horizon.stellar.org',
    STELLAR_USDC_ISSUER: MAINNET_USDC_ISSUER,
    HORIZON_URLS: '',
  });
  assert.equal(result.network, 'public');
  assert.equal(result.isMainnet, true);
  assert.equal(result.problems, 0);
  assert.equal(result.passphrase, 'Public Global Stellar Network ; September 2015');
});

test('env.js defaults the USDC issuer from the resolved profile', () => {
  const result = loadEnv({ STELLAR_NETWORK: 'testnet', STELLAR_USDC_ISSUER: '', HORIZON_URLS: '' });
  assert.equal(result.issuer, TESTNET_USDC_ISSUER);
  assert.equal(result.problems, 0);
});
