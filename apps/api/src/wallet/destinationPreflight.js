// Preflight checks for payment destinations. Used by the WhatsApp assistant
// before asking for a PIN, and re-checked just before submission, so customers
// learn about invalid accounts, missing trustlines, and unsupported
// destinations before they are asked to confirm with a PIN.
const { server, StellarSdk } = require("../config/stellar");
const config = require("../config/env");
const { validateAddress } = require("./stellar.adapter");

const PREFLIGHT_CACHE_TTL_MS = 30 * 1000;
const preflightCache = new Map();

const getBaseAccountId = (destination) => {
  if (StellarSdk.StrKey.isValidMed25519PublicKey(destination)) {
    const decoded = StellarSdk.StrKey.decodeMed25519PublicKey(destination);
    return StellarSdk.StrKey.encodeEd25519PublicKey(decoded.slice(0, 32));
  }
  return destination;
};

const resolveAsset = (asset) => {
  if (!asset || asset === "XLM" || asset === "native") {
    return StellarSdk.Asset.native();
  }
  if (asset === "USDC") {
    return new StellarSdk.Asset("USDC", config.stellar.usdcIssuer);
  }
  throw new Error(`Unsupported asset: ${asset}`);
};

const getCachedPreflight = (key) => {
  const cached = preflightCache.get(key);
  if (!cached) return undefined;
  if (cached.expires <= Date.now()) {
    preflightCache.delete(key);
    return undefined;
  }
  return cached.result;
};

const setCachedPreflight = (key, result) => {
  // Cache only positive results: a destination that is ready today may not be
  // ready in a few seconds, but re-checking on every confirmation is wasteful.
  if (result && result.ok) {
    preflightCache.set(key, {
      expires: Date.now() + PREFLIGHT_CACHE_TTL_MS,
      result,
    });
  }
};

const checkDestinationReadiness = async ({ destination, asset = "XLM" }) => {
  const address = String(destination || "").trim();
  if (!validateAddress(address)) {
    return {
      ok: false,
      reason: "invalid_address",
      message: "Destination must be a valid Stellar address.",
    };
  }

  const baseDestination = getBaseAccountId(address);
  const cacheKey = `readiness:${baseDestination}:${asset}`;
  const cached = getCachedPreflight(cacheKey);
  if (cached) return cached;

  let account;
  try {
    account = await server.loadAccount(baseDestination);
  } catch (_error) {
    return {
      ok: false,
      reason: "account_not_found",
      message: "Destination account does not exist or is not funded.",
    };
  }

  if (asset && asset !== "XLM" && asset !== "native") {
    let resolved;
    try {
      resolved = resolveAsset(asset);
    } catch (error) {
      return {
        ok: false,
        reason: "unsupported_asset",
        message: error.message,
      };
    }
    const code = resolved.getCode();
    const issuer = resolved.getIssuer();
    const trustline = (account.balances || []).find(
      (b) => b.asset_code === code && b.asset_issuer === issuer,
    );
    if (!trustline) {
      return {
        ok: false,
        reason: "missing_trustline",
        message: `The recipient can't receive ${code} yet.`,
      };
    }
    if (trustline.is_authorized === false) {
      return {
        ok: false,
        reason: "not_authorized",
        message: `The recipient isn't authorized to receive ${code} yet.`,
      };
    }
  }

  const result = {
    ok: true,
    message: "Destination is ready to receive this asset.",
  };
  setCachedPreflight(cacheKey, result);
  return result;
};

module.exports = { checkDestinationReadiness };