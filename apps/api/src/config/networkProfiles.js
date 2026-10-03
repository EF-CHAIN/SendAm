// Stellar network profiles.
//
// A network is not just a name: the passphrase, Horizon endpoint, asset
// issuers, explorer, and whether Friendbot exists all have to agree, or the
// service will happily sign mainnet transactions against testnet material.
// Each supported network is declared here as one coherent bundle, and
// configuration is validated against that bundle rather than against a single
// string comparison.

/**
 * @typedef {Object} NetworkProfile
 * @property {string} id - Canonical network identifier (e.g. 'testnet', 'public').
 * @property {string} label - Human-readable display name for the network.
 * @property {boolean} isMainnet - True if the profile targets a live mainnet network moving real funds.
 * @property {string} passphrase - Stellar network passphrase used for cryptographic transaction signing and hashing.
 * @property {readonly string[]} horizonHosts - Allowlist of valid Horizon hostname strings for this network.
 * @property {string} defaultHorizonUrl - Default Horizon REST API base URL for this network.
 * @property {string} usdcIssuer - Circle's canonical USDC issuing Stellar G-address (StrKey) on this network.
 * @property {string} explorerBaseUrl - Base URL for looking up transactions and accounts on StellarExpert block explorer.
 * @property {boolean} supportsFriendbot - True if automated testnet Friendbot account funding is supported.
 * @property {string | null} friendbotUrl - Friendbot service URL for account creation and funding, or null on mainnet.
 */

/**
 * @typedef {Object} NetworkResolutionResult
 * @property {NetworkProfile|null} profile - Resolved network profile, or null if the network ID is invalid.
 * @property {string[]} problems - List of detected configuration inconsistency error messages.
 */

// Circle's USDC issuers. These are the only two this service recognises.
const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const MAINNET_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

/** @type {Readonly<Record<'testnet' | 'public', Readonly<NetworkProfile>>>} */
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
  main: 'public',
  pub: 'public',
});

const SUPPORTED_NETWORK_IDS = Object.freeze(Object.keys(NETWORK_ALIASES).sort());

/**
 * Strkey shape check: 56 characters of RFC 4648 base32 beginning with G.
 *
 * @param {unknown} value - Value to validate as a Stellar account StrKey address.
 * @returns {boolean} True if value is a valid 56-character Stellar account address.
 */
const isAccountStrkey = (value) =>
  typeof value === 'string' && value.length === 56 && /^G[A-Z2-7]{55}$/.test(value);

/**
 * Map a configured network name onto its canonical id.
 * Returns `null` for anything not explicitly supported.
 *
 * @param {string | unknown} raw - Raw network identifier input.
 * @returns {'testnet' | 'public' | null} Canonical network ID or null if unrecognised.
 */
const normalizeNetworkId = (raw) => {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  return NETWORK_ALIASES[key] || null;
};

/**
 * The profile for a canonical id, or `null`.
 *
 * @param {string} id - Canonical network ID.
 * @returns {Readonly<NetworkProfile> | null} Network profile object or null.
 */
const getNetworkProfile = (id) => NETWORK_PROFILES[id] || null;

/**
 * Extract hostname from a URL string safely.
 * @param {string} url - URL string.
 * @returns {string | null} Hostname or null if malformed.
 */
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
 *
 * @param {Object} [options={}] - Configuration options.
 * @param {string} [options.network] - Network identifier or alias.
 * @param {string|null} [options.horizonUrl] - Horizon server URL.
 * @param {string[]} [options.horizonUrls] - Array of fallback Horizon URLs.
 * @param {string|null} [options.usdcIssuer] - Configured USDC issuer address.
 * @param {boolean} [options.allowMainnet=false] - Whether mainnet operation is explicitly confirmed.
 * @param {boolean} [options.enableFriendbot=false] - Whether Friendbot funding is enabled.
 * @returns {NetworkResolutionResult} Resolved profile and list of validation issues.
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
 *
 * @param {Object} [options] - Configuration resolution options passed to resolveNetworkProfile.
 * @returns {Readonly<NetworkProfile>} Resolved network profile.
 * @throws {Error} If any validation problems are detected.
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
 *
 * @param {Readonly<NetworkProfile> | null} profile - Network profile to summarize.
 * @returns {Object} Safe metadata summary of the profile.
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
