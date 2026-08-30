// Stellar network profiles.
//
// A network is not just a name: the passphrase, Horizon endpoint, asset
// issuers, explorer, and whether Friendbot exists all have to agree, or the
// service will happily sign mainnet transactions against testnet material.
// Each supported network is declared here as one coherent bundle, and
// configuration is validated against that bundle rather than against a single
// string comparison.

// Circle's USDC issuers. These are the only two this service recognises.
const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const MAINNET_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

const NETWORK_PROFILES = Object.freeze({
  testnet: Object.freeze({
    id: 'testnet',
    label: 'Stellar Testnet',
    isMainnet: false,
    passphrase: 'Test SDF Network ; September 2015',
    horizonHosts: Object.freeze(['horizon-testnet.stellar.org']),
    defaultHorizonUrl: 'https://horizon-testnet.stellar.org',
    usdcIssuer: TESTNET_USDC_ISSUER,
    explorerBaseUrl: 'https://stellar.expert/explorer/testnet',
    // Friendbot only exists on test networks; funding is free there.
    supportsFriendbot: true,
    friendbotUrl: 'https://friendbot.stellar.org',
  }),
  public: Object.freeze({
    id: 'public',
    label: 'Stellar Public Network (mainnet)',
    isMainnet: true,
    passphrase: 'Public Global Stellar Network ; September 2015',
    horizonHosts: Object.freeze(['horizon.stellar.org']),
    defaultHorizonUrl: 'https://horizon.stellar.org',
    usdcIssuer: MAINNET_USDC_ISSUER,
    explorerBaseUrl: 'https://stellar.expert/explorer/public',
    supportsFriendbot: false,
    friendbotUrl: null,
  }),
});

// Accepted spellings for each canonical id. Anything not listed here is
// rejected — `testent` must fail startup, not silently select mainnet.
const NETWORK_ALIASES = Object.freeze({
  testnet: 'testnet',
  test: 'testnet',
  'test-network': 'testnet',
  public: 'public',
  pubnet: 'public',
  mainnet: 'public',
});

const SUPPORTED_NETWORK_IDS = Object.freeze(Object.keys(NETWORK_ALIASES).sort());

/** Strkey shape check: 56 characters of RFC 4648 base32 beginning with G. */
const isAccountStrkey = (value) =>
  typeof value === 'string' && value.length === 56 && /^G[A-Z2-7]{55}$/.test(value);

/**
 * Map a configured network name onto its canonical id.
 * Returns `null` for anything not explicitly supported.
 */
const normalizeNetworkId = (raw) => {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  return NETWORK_ALIASES[key] || null;
};

/** The profile for a canonical id, or `null`. */
const getNetworkProfile = (id) => NETWORK_PROFILES[id] || null;

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch (_error) {
    return null;
  }
};

/**
 * Resolve and validate a network configuration as one coherent profile.
 *
 * Returns `{ profile, problems }`. `profile` is null when the network name
 * itself is unusable; otherwise it is the resolved bundle even if `problems`
 * is non-empty, so callers can report every inconsistency at once instead of
 * one per restart.
 *
 * `allowMainnet` is the explicit confirmation control: selecting the public
 * network is refused unless the operator has separately opted in, so no single
 * typo or copied env file can move real funds.
 */
const resolveNetworkProfile = ({
  network,
  horizonUrl = null,
  horizonUrls = [],
  usdcIssuer = null,
  allowMainnet = false,
  enableFriendbot = false,
} = {}) => {
  const problems = [];

  const id = normalizeNetworkId(network);
  if (!id) {
    problems.push(
      `STELLAR_NETWORK must be one of: ${SUPPORTED_NETWORK_IDS.join(', ')} `
      + `(got ${JSON.stringify(network)}). Unrecognised values are rejected rather than `
      + 'defaulting to a network, so a typo cannot select mainnet.',
    );
    return { profile: null, problems };
  }

  const profile = NETWORK_PROFILES[id];

  if (profile.isMainnet && !allowMainnet) {
    problems.push(
      `STELLAR_NETWORK selects ${profile.label}. Set STELLAR_ALLOW_MAINNET=true to confirm `
      + 'this deployment is intended to move real funds.',
    );
  }

  // Every configured Horizon endpoint must belong to the selected network.
  // Pointing a mainnet deployment at testnet Horizon (or the reverse) is the
  // failure this is here to stop.
  const configuredHorizon = [horizonUrl, ...(Array.isArray(horizonUrls) ? horizonUrls : [])].filter(Boolean);
  for (const url of configuredHorizon) {
    const host = hostOf(url);
    if (!host) {
      problems.push(`Horizon URL ${JSON.stringify(url)} is not a valid URL.`);
      continue;
    }
    if (!profile.horizonHosts.includes(host)) {
      problems.push(
        `Horizon URL ${url} does not belong to ${profile.label}. `
        + `Expected one of: ${profile.horizonHosts.join(', ')}.`,
      );
    }
    if (profile.isMainnet && !url.startsWith('https://')) {
      problems.push(`Horizon URL ${url} must use HTTPS on ${profile.label}.`);
    }
  }

  // The USDC issuer must be the one belonging to this network. Checking
  // equality rather than "not the other one" also catches a malformed key.
  if (usdcIssuer !== null && usdcIssuer !== undefined && usdcIssuer !== '') {
    if (!isAccountStrkey(usdcIssuer)) {
      problems.push(
        `STELLAR_USDC_ISSUER ${JSON.stringify(usdcIssuer)} is not a valid Stellar account address `
        + '(56 characters, base32, starting with G).',
      );
    } else if (usdcIssuer !== profile.usdcIssuer) {
      const other = usdcIssuer === TESTNET_USDC_ISSUER
        ? ' That is the Testnet issuer.'
        : usdcIssuer === MAINNET_USDC_ISSUER
          ? ' That is the mainnet issuer.'
          : '';
      problems.push(
        `STELLAR_USDC_ISSUER does not match ${profile.label}.${other} `
        + `Expected ${profile.usdcIssuer}.`,
      );
    }
  }

  if (enableFriendbot && !profile.supportsFriendbot) {
    problems.push(
      `Friendbot funding is not available on ${profile.label}. `
      + 'Disable it, or fund accounts through a real payment path.',
    );
  }

  return { profile, problems };
};

/**
 * Resolve a profile or refuse to continue.
 * Used at startup so an inconsistent network never reaches request handling.
 */
const assertNetworkProfile = (options) => {
  const { profile, problems } = resolveNetworkProfile(options);
  if (problems.length > 0) {
    throw new Error(`Invalid Stellar network configuration:\n  - ${problems.join('\n  - ')}`);
  }
  return profile;
};

/**
 * A summary safe to log at startup and expose in health metadata: identifies
 * the network without revealing credentials.
 */
const describeNetworkProfile = (profile) => {
  if (!profile) return { network: 'unresolved', isMainnet: false };
  return {
    network: profile.id,
    label: profile.label,
    isMainnet: profile.isMainnet,
    passphrase: profile.passphrase,
    horizonHosts: [...profile.horizonHosts],
    usdcIssuer: profile.usdcIssuer,
    explorerBaseUrl: profile.explorerBaseUrl,
    supportsFriendbot: profile.supportsFriendbot,
  };
};

module.exports = {
  NETWORK_PROFILES,
  SUPPORTED_NETWORK_IDS,
  TESTNET_USDC_ISSUER,
  MAINNET_USDC_ISSUER,
  normalizeNetworkId,
  getNetworkProfile,
  resolveNetworkProfile,
  assertNetworkProfile,
  describeNetworkProfile,
  isAccountStrkey,
};
