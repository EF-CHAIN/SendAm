'use strict';

// Canonical Stellar asset identity (#285).
//
// Anyone can issue a token on Stellar with any code, including "USDC" — the
// asset code alone proves nothing about who issued it. A trustworthy asset
// identity is always the triple (network, code, issuer), with native XLM as
// the one asset that has no issuer at all. Every place in the codebase that
// labels, values, notifies about, or applies policy to a Stellar asset must
// go through this module rather than comparing `asset_code` on its own.

const { NETWORK_PROFILES } = require('../config/networkProfiles');

const CHAIN = 'stellar';

// Issued assets this service recognises as trusted, keyed by asset code and
// then by network id to the single issuer that code means on that network.
// Sourced from the network profiles (#284) so the testnet/mainnet USDC
// issuers are declared in exactly one place.
const TRUSTED_ISSUERS = Object.freeze({
  USDC: Object.freeze(
    Object.fromEntries(
      Object.values(NETWORK_PROFILES)
        .filter((profile) => profile.usdcIssuer)
        .map((profile) => [profile.id, profile.usdcIssuer]),
    ),
  ),
});

/** The configured issuer for `code` on `network`, or null if there isn't one. */
const trustedIssuerFor = (network, code) => TRUSTED_ISSUERS[code]?.[network] || null;

/** Canonical identity for native XLM on a given network. */
const nativeAssetId = (network) => ({
  chain: CHAIN,
  network,
  code: 'XLM',
  issuer: null,
});

/**
 * Stable string form of a canonical asset identity — network plus
 * native/code/issuer — suitable for keys, logs, and cross-system references.
 */
const canonicalAssetKey = ({ network, code, issuer }) => (
  issuer ? `${CHAIN}:${network}:${code}:${issuer}` : `${CHAIN}:${network}:${code}`
);

/**
 * True only when `issuer` is exactly this service's configured issuer for
 * `code` on `network`. A same-code trustline or payment from any other
 * issuer — including a token deliberately named to look like a trusted
 * asset — is never trusted, regardless of code.
 */
const isTrustedIssuedAsset = ({ network, code, issuer }) => {
  const expected = trustedIssuerFor(network, code);
  return Boolean(expected) && Boolean(issuer) && expected === issuer;
};

/**
 * Describe a balance line or payment operation's asset as one canonical
 * identity. `assetType` follows Horizon's vocabulary ('native',
 * 'credit_alphanum4', 'credit_alphanum12'); native assets ignore `code`/
 * `issuer`. Returns the network-qualified code/issuer, a canonical key, and
 * whether this service recognises the issuer — callers must gate labeling,
 * valuing, notifying, and policy on `trusted`, not on `code` alone.
 */
const describeAsset = ({ network, assetType, code, issuer }) => {
  if (assetType === 'native') {
    const id = nativeAssetId(network);
    return { ...id, assetId: canonicalAssetKey(id), trusted: true };
  }

  const resolvedCode = code || assetType || 'UNKNOWN';
  const resolvedIssuer = issuer || null;
  const trusted = isTrustedIssuedAsset({ network, code: resolvedCode, issuer: resolvedIssuer });

  return {
    chain: CHAIN,
    network,
    code: resolvedCode,
    issuer: resolvedIssuer,
    assetId: canonicalAssetKey({ network, code: resolvedCode, issuer: resolvedIssuer }),
    trusted,
  };
};

/**
 * The issuer this service would use for `code` on `network` at send time —
 * null for native XLM or a code this deployment doesn't issue/trust.
 * Used to record issuer provenance on outbound transactions, whose asset is
 * always resolved from configuration (see stellar.adapter.resolveAsset)
 * rather than read off-chain, so this never needs a live account lookup.
 */
const resolveConfiguredIssuer = ({ network, code }) => {
  if (!code || code === 'XLM' || code === 'native') return null;
  return trustedIssuerFor(network, code);
};

module.exports = {
  CHAIN,
  TRUSTED_ISSUERS,
  nativeAssetId,
  canonicalAssetKey,
  isTrustedIssuedAsset,
  describeAsset,
  resolveConfiguredIssuer,
};
