/**
 * Module: External Wallet & Asset Metadata Verifier (#339)
 *
 * Validates customer and destination metadata formats, enforces Stellar public key format (G-address),
 * verifies asset codes and issuers, and checks cryptographic provenance signatures for trusted metadata sources.
 */

const crypto = require('crypto');

class MetadataVerifier {
  constructor(options = {}) {
    this.trustedSecret = options.trustedSecret || process.env.METADATA_SIGNING_SECRET || 'default_sendam_metadata_secret';
    this.allowedAssets = options.allowedAssets || ['XLM', 'USDC', 'EURC', 'NGN'];
  }

  /**
   * Validates Stellar public key address format (G... 56 chars).
   */
  isValidStellarAddress(address) {
    if (!address || typeof address !== 'string') return false;
    const trimmed = address.trim();
    return /^G[A-Z2-7]{55}$/.test(trimmed);
  }

  /**
   * Validates Stellar asset metadata.
   */
  isValidAsset(assetCode, assetIssuer) {
    if (!assetCode || typeof assetCode !== 'string') return false;
    const code = assetCode.trim().toUpperCase();

    if (!this.allowedAssets.includes(code)) {
      return false;
    }

    if (code === 'XLM') return true;

    // Non-native assets must have a valid issuer address
    return this.isValidStellarAddress(assetIssuer);
  }

  /**
   * Generates HMAC provenance signature for trusted metadata payload.
   */
  generateSignature(payload) {
    const dataStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return crypto.createHmac('sha256', this.trustedSecret).update(dataStr).digest('hex');
  }

  /**
   * Verifies provenance signature of external metadata payload.
   */
  verifySignature(payload, signature) {
    if (!signature || typeof signature !== 'string') return false;
    const expected = this.generateSignature(payload);
    const bufSig = Buffer.from(signature);
    const bufExp = Buffer.from(expected);
    if (bufSig.length !== bufExp.length) return false;
    return crypto.timingSafeEqual(bufSig, bufExp);
  }

  /**
   * Complete validation pipeline for external wallet and asset metadata.
   */
  validateMetadata(metadata = {}) {
    const errors = [];

    const {
      destinationAddress,
      assetCode = 'XLM',
      assetIssuer,
      sourceSignature,
      requireSignature = false,
    } = metadata;

    if (!this.isValidStellarAddress(destinationAddress)) {
      errors.push(`Invalid destination Stellar wallet address format: '${destinationAddress}'`);
    }

    if (!this.isValidAsset(assetCode, assetIssuer)) {
      errors.push(`Invalid or unapproved asset combination: code='${assetCode}', issuer='${assetIssuer}'`);
    }

    if (requireSignature) {
      const payloadToSign = { destinationAddress, assetCode, assetIssuer };
      if (!this.verifySignature(payloadToSign, sourceSignature)) {
        errors.push('Cryptographic provenance signature check failed for external metadata source.');
      }
    }

    const isValid = errors.length === 0;

    return {
      isValid,
      errors,
      validatedMetadata: isValid
        ? {
            destinationAddress: destinationAddress.trim(),
            assetCode: assetCode.trim().toUpperCase(),
            assetIssuer: assetIssuer ? assetIssuer.trim() : null,
            isVerified: true,
          }
        : null,
    };
  }
}

const metadataVerifier = new MetadataVerifier();

module.exports = {
  MetadataVerifier,
  metadataVerifier,
};
