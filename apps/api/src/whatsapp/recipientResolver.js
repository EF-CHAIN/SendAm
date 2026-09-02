const { isValidPhoneNumber, canonicalizePhoneNumber } = require('../utils/validators');
const StellarSdk = require('@stellar/stellar-sdk');

const PHONE_SHAPE = /^\+?\d[\ds]-{4,17}$/;
// eslint-disable-next-line no-unused-vars
const looksLikePhoneNumber = (raw) => PHONE_SHAPE.test(raw) && isValidPhoneNumber(raw);

const PREFLIGHT_CACHE_TTL_MS = 30 * 1000;
const preflightCache = new Map();

/**
 * Preflight checks for a Stellar payment destination.
 * Verifies destination existence, asset trustline, authorization flags,
 * and muxed/memo policy. Successful results are cached briefly.
 */
async function preflightDestination({ stellarService, destination, asset, memo, useCache = true }) {
  const cacheKey = `${destination}:${asset ? asset.toString() : 'XLM'},${memo || ''}`;

  if (useCache) {
    const now = Date.now();
    const cached = preflightCache.get(cacheKey);
    if (cached && now < cached.expiresAt) {
      return cached.result;
    }
  }

  const errors = [];

  // Destination format validation
  if (
    !StellarSdk.StrKey.isValidEd25519PublicKey(destination) &&
    !StellarSdk.StrKey.isValidMed25519PublicKey(destination)
  ) {
    errors.push('Destination is not a valid Stellar address.');
    return { success: false, errors };
  }

  try {
    const account = await stellarService.loadAccount(destination);
    if (!account || account.error) {
      errors.push('Destination account does not exist.');
    } else {
      // Asset-specific checks
      if (asset && !asset.isNative()) {
        const code = asset.getCode();
        const issuer = asset.getIssuer();

        const trustline = (account.balances || []).find(
          (b) => b.asset_code === code && b.asset_issuer === issuer
        );

        if (!trustline) {
          errors.push(`Destination does not trust ${code}.`);
        } else if (trustline.is_authorized === false) {
          errors.push(`Destination is not authorized to receive ${code}.`);
        }
      }

      // Muxed accounts require a memo
      if (StellarSdk.StrKey.isValidMed25519PublicKey(destination) && !memo) {
        errors.push('Destination is a muxed account and requires a memo.');
      }
    }
  // eslint-disable-next-line no-unused-vars
  } catch (error) {
    errors.push('Unable to verify destination account.');
  }

  const result = { success: errors.length === 0, errors };

  // Cache only safe reads
  if (result.success) {
    preflightCache.set(cacheKey, {
      expiresAt: Date.now() + PREFLIGHT_CACHE_TTL_MS,
      result,
    });
  }

  return result;
}

/**
 * Resolves recipient identifiers in the following precedence order:
 * 1. Saved contacts (name lookup)
 * 2. Phone numbers (creates or fetches user wallet)
 * 3. @names
 * 4. Raw G... Stellar addresses
 */
const createRecipientResolver = ({ prisma, walletService }) => {
  const service = typeof walletService === 'function' ? walletService() : walletService;

  return async (user, recipient) => {
    const raw = String(recipient || '').trim();
    const normalized = raw.toLowerCase();

    // eslint-disable-next-line no-unused-vars
    let result;

    // 1. Saved contacts - exact alias match.
    const savedAlias = await prisma.alias.findUnique({
      where: { userId_alias: { userId: user.id, alias: normalized } },
    });
    if (savedAlias) {
      return { destination: savedAlias.target, label: normalized };
    }

    // 2. Phone number — create or fetch wallet for that phone number.
    if (service && isValidPhoneNumber(raw)) {
      const canonicalPhone = canonicalizePhoneNumber(raw);
      const wallet = await service.createOrGetWallet({ phoneNumber: canonicalPhone });
      return { destination: wallet.publicKey, label: canonicalPhone };
    }

    // 3. Raw address (or unresolvable name)
    return { destination: raw, label: raw };
  };
};

module.exports = { createRecipientResolver, preflightDestination };
