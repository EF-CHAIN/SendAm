'use strict';

const crypto = require('crypto');
const { isContractStrkey } = require('../config/soroban');
const logger = require('../utils/logger');

const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_RP_ID = process.env.WEBAUTHN_RP_ID || 'sendam.me';
const DEFAULT_ORIGIN = process.env.WEBAUTHN_ORIGIN || 'https://sendam.me';

// NIST P-256 (secp256r1) SPKI prefix for uncompressed 65-byte point (0x04 || X || Y)
const SECP256R1_SPKI_HEADER_HEX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';

class PasskeyError extends Error {
  constructor(message, code = 'PASSKEY_ERROR', statusCode = 400) {
    super(message);
    this.name = 'PasskeyError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

class ChallengeExpiredError extends PasskeyError {
  constructor(message = 'WebAuthn challenge has expired') {
    super(message, 'CHALLENGE_EXPIRED', 400);
  }
}

class InvalidSignatureError extends PasskeyError {
  constructor(message = 'Invalid secp256r1 passkey signature') {
    super(message, 'INVALID_SIGNATURE', 401);
  }
}

class UserVerificationRequiredError extends PasskeyError {
  constructor(message = 'Biometric user verification (FaceID/TouchID) was not confirmed by the authenticator') {
    super(message, 'USER_VERIFICATION_REQUIRED', 403);
  }
}

/**
 * Normalizes base64url or base64 or Buffer to Buffer.
 */
function toBuffer(val, name = 'input') {
  if (Buffer.isBuffer(val)) return val;
  if (val && typeof val.export === 'function') {
    return val.export({ type: 'spki', format: 'der' });
  }
  if (typeof val === 'string') {
    if (val.includes('-----BEGIN')) {
      const b64 = val.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
      return Buffer.from(b64, 'base64');
    }
    const base64 = val.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(base64, 'base64');
  }
  throw new PasskeyError(`Expected ${name} to be a Buffer or base64 string`, 'INVALID_INPUT_TYPE');
}

/**
 * Base64url encodes a buffer or string.
 */
function toBase64Url(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Parse and normalize an uncompressed or SPKI secp256r1 public key into a Node KeyObject.
 */
function normalizeSecp256r1PublicKey(pubKeyInput) {
  if (pubKeyInput && typeof pubKeyInput.export === 'function') {
    return pubKeyInput; // Already a KeyObject
  }

  let buf;
  if (typeof pubKeyInput === 'string' && pubKeyInput.includes('-----BEGIN PUBLIC KEY-----')) {
    return crypto.createPublicKey(pubKeyInput);
  }

  buf = toBuffer(pubKeyInput, 'publicKey');

  // If already standard SPKI DER (89 or 91 bytes)
  if (buf.length === 91 || buf.length === 89) {
    return crypto.createPublicKey({ key: buf, format: 'der', type: 'spki' });
  }

  // If 65-byte uncompressed point (0x04 || X || Y)
  if (buf.length === 65 && buf[0] === 0x04) {
    const spkiDer = Buffer.concat([Buffer.from(SECP256R1_SPKI_HEADER_HEX, 'hex'), buf]);
    return crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
  }

  // If 64-byte raw coordinates (X || Y)
  if (buf.length === 64) {
    const spkiDer = Buffer.concat([
      Buffer.from(SECP256R1_SPKI_HEADER_HEX, 'hex'),
      Buffer.from([0x04]),
      buf,
    ]);
    return crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
  }

  throw new PasskeyError(
    `Unsupported secp256r1 public key format (length: ${buf.length} bytes)`,
    'INVALID_PUBLIC_KEY'
  );
}

/**
 * WebAuthn Passkey Signing Adapter for Direct Customer Custody.
 *
 * Implements self-custody authorization for Soroban smart wallet accounts using FaceID/TouchID.
 * The backend generates cryptographic challenges and verifies WebAuthn secp256r1 signatures
 * without ever storing user private keys or passkey secrets.
 */
class PasskeyAdapter {
  constructor({
    rpId = DEFAULT_RP_ID,
    origin = DEFAULT_ORIGIN,
    challengeTtlMs = DEFAULT_CHALLENGE_TTL_MS,
  } = {}) {
    this.rpId = rpId;
    this.origin = origin;
    this.challengeTtlMs = challengeTtlMs;
    this._challenges = new Map(); // challengeId -> challenge record
  }

  /**
   * Generates a cryptographic WebAuthn challenge for mobile FaceID/TouchID prompt.
   * Can be bound to a specific transfer action, amount, or recipient.
   */
  createChallenge({
    userId = null,
    smartWalletAddress = null,
    action = 'transfer.authorize',
    payloadHash = null,
    ttlMs = null,
    origin = null,
    rpId = null,
  } = {}) {
    if (smartWalletAddress && !isContractStrkey(smartWalletAddress)) {
      throw new PasskeyError(`Invalid Soroban smart wallet address: ${smartWalletAddress}`, 'INVALID_SMART_WALLET');
    }

    const rawRandom = crypto.randomBytes(32);
    const challenge = toBase64Url(rawRandom);
    const challengeId = `ch_${crypto.randomBytes(16).toString('hex')}`;
    const expiresAt = Date.now() + (ttlMs || this.challengeTtlMs);

    const record = {
      challengeId,
      challenge,
      userId,
      smartWalletAddress,
      action,
      payloadHash,
      rpId: rpId || this.rpId,
      origin: origin || this.origin,
      createdAt: Date.now(),
      expiresAt,
      consumed: false,
    };

    this._challenges.set(challenge, record);

    // Clean up expired challenges periodically
    this._purgeExpiredChallenges();

    return {
      challengeId,
      challenge,
      rpId: record.rpId,
      origin: record.origin,
      expiresAt,
      smartWalletAddress,
      action,
    };
  }

  /**
   * Consumes a challenge ensuring it is valid, unconsumed, and not expired.
   */
  consumeChallenge(challengeString) {
    if (!challengeString) {
      throw new PasskeyError('Challenge string is required', 'MISSING_CHALLENGE');
    }

    const record = this._challenges.get(challengeString);
    if (!record) {
      throw new PasskeyError('Unknown or invalid WebAuthn challenge', 'CHALLENGE_NOT_FOUND');
    }

    if (record.consumed) {
      throw new PasskeyError('Challenge has already been consumed (replay prevention)', 'CHALLENGE_REPLAYED');
    }

    if (Date.now() > record.expiresAt) {
      this._challenges.delete(challengeString);
      throw new ChallengeExpiredError();
    }

    record.consumed = true;
    this._challenges.delete(challengeString); // Delete to guarantee single use
    return record;
  }

  /**
   * Verifies an incoming WebAuthn assertion:
   * 1. Validates clientDataJSON (challenge match, type, origin).
   * 2. Validates authenticatorData (flags: User Present UP, User Verified UV).
   * 3. Validates secp256r1 signature over authenticatorData || sha256(clientDataJSON).
   */
  verifyAssertion({
    clientDataJSON,
    authenticatorData,
    signature,
    publicKey,
    expectedChallenge = null,
    expectedOrigin = null,
    expectedRpId = null,
    requireUserVerification = true,
  }) {
    if (!clientDataJSON) throw new PasskeyError('Missing clientDataJSON', 'MISSING_CLIENT_DATA');
    if (!authenticatorData) throw new PasskeyError('Missing authenticatorData', 'MISSING_AUTHENTICATOR_DATA');
    if (!signature) throw new PasskeyError('Missing signature', 'MISSING_SIGNATURE');
    if (!publicKey) throw new PasskeyError('Missing secp256r1 public key', 'MISSING_PUBLIC_KEY');

    const clientDataBuf = toBuffer(clientDataJSON, 'clientDataJSON');
    const authDataBuf = toBuffer(authenticatorData, 'authenticatorData');
    const sigBuf = toBuffer(signature, 'signature');

    // 1. Parse and validate clientDataJSON
    let parsedClientData;
    try {
      parsedClientData = JSON.parse(clientDataBuf.toString('utf8'));
    } catch (err) {
      throw new PasskeyError(`Invalid clientDataJSON: ${err.message}`, 'INVALID_CLIENT_DATA_JSON');
    }

    if (parsedClientData.type !== 'webauthn.get') {
      throw new PasskeyError(
        `Unexpected clientDataJSON type: expected "webauthn.get", got "${parsedClientData.type}"`,
        'INVALID_CLIENT_DATA_TYPE'
      );
    }

    // Verify challenge match
    const resolvedExpectedChallenge = expectedChallenge || parsedClientData.challenge;
    if (parsedClientData.challenge !== resolvedExpectedChallenge) {
      throw new PasskeyError('Challenge mismatch in clientDataJSON', 'CHALLENGE_MISMATCH');
    }

    // If challenge was stored in our pool, consume it
    let challengeRecord = null;
    if (this._challenges.has(parsedClientData.challenge)) {
      challengeRecord = this.consumeChallenge(parsedClientData.challenge);
    }

    // Verify origin
    const resolvedExpectedOrigin = expectedOrigin || (challengeRecord?.origin || this.origin);
    if (resolvedExpectedOrigin && parsedClientData.origin !== resolvedExpectedOrigin) {
      throw new PasskeyError(
        `Origin mismatch: expected "${resolvedExpectedOrigin}", got "${parsedClientData.origin}"`,
        'ORIGIN_MISMATCH'
      );
    }

    // 2. Parse and validate authenticatorData
    if (authDataBuf.length < 37) {
      throw new PasskeyError('authenticatorData is shorter than minimum 37 bytes', 'INVALID_AUTHENTICATOR_DATA');
    }

    const rpIdHash = authDataBuf.slice(0, 32);
    const flags = authDataBuf[32];
    const signCount = authDataBuf.readUInt32BE(33);

    // Flag bits:
    // Bit 0: User Present (UP)
    // Bit 2: User Verified (UV) - biometrics/PIN
    const userPresent = Boolean(flags & 0x01);
    const userVerified = Boolean(flags & 0x04);

    if (!userPresent) {
      throw new PasskeyError('Authenticator reported User Present flag not set', 'USER_NOT_PRESENT');
    }

    if (requireUserVerification && !userVerified) {
      throw new UserVerificationRequiredError(
        'User biometrics (FaceID/TouchID) or PIN verification was not performed'
      );
    }

    // Optional RP ID Hash check
    const resolvedRpId = expectedRpId || (challengeRecord?.rpId || this.rpId);
    if (resolvedRpId) {
      const expectedRpIdHash = crypto.createHash('sha256').update(resolvedRpId).digest();
      if (!crypto.timingSafeEqual(rpIdHash, expectedRpIdHash)) {
        throw new PasskeyError('RP ID hash mismatch in authenticatorData', 'RP_ID_MISMATCH');
      }
    }

    // 3. Cryptographic signature verification (secp256r1)
    // The authenticator signs: authenticatorData || sha256(clientDataJSON)
    const clientDataHash = crypto.createHash('sha256').update(clientDataBuf).digest();
    const signedData = Buffer.concat([authDataBuf, clientDataHash]);

    const keyObject = normalizeSecp256r1PublicKey(publicKey);

    let isValid = false;
    try {
      // First try standard ASN.1 DER ECDSA verification
      isValid = crypto.verify('SHA256', signedData, keyObject, sigBuf);
    } catch (_derErr) {
      // If DER verification threw, check if signature is raw 64-byte IEEE P1363 (r, s)
      if (sigBuf.length === 64) {
        try {
          isValid = crypto.verify(
            'SHA256',
            signedData,
            { key: keyObject, dsaEncoding: 'ieee-p1363' },
            sigBuf
          );
        } catch (_p1363Err) {
          isValid = false;
        }
      }
    }

    // If standard didn't pass and signature is 64 bytes, also try ieee-p1363
    if (!isValid && sigBuf.length === 64) {
      try {
        isValid = crypto.verify(
          'SHA256',
          signedData,
          { key: keyObject, dsaEncoding: 'ieee-p1363' },
          sigBuf
        );
      } catch (_err) {
        isValid = false;
      }
    }

    if (!isValid) {
      throw new InvalidSignatureError();
    }

    return {
      verified: true,
      userPresent,
      userVerified,
      signCount,
      challenge: parsedClientData.challenge,
      origin: parsedClientData.origin,
      challengeRecord,
    };
  }

  /**
   * Prepares the Soroban smart wallet authorization payload.
   * Packages the verified passkey assertion into a contract-compatible format
   * for Soroban smart wallet accounts (secp256r1 verification on-chain).
   */
  buildSorobanSmartWalletAuth({
    smartWalletAddress,
    clientDataJSON,
    authenticatorData,
    signature,
    publicKey,
  }) {
    if (!isContractStrkey(smartWalletAddress)) {
      throw new PasskeyError(`Invalid Soroban smart wallet address: ${smartWalletAddress}`, 'INVALID_SMART_WALLET');
    }

    const clientDataBuf = toBuffer(clientDataJSON, 'clientDataJSON');
    const authDataBuf = toBuffer(authenticatorData, 'authenticatorData');
    const sigBuf = toBuffer(signature, 'signature');
    const pubKeyBuf = toBuffer(publicKey, 'publicKey');

    return {
      smartWalletAddress,
      authMethod: 'webauthn_secp256r1',
      clientDataJSON: toBase64Url(clientDataBuf),
      authenticatorData: toBase64Url(authDataBuf),
      signature: toBase64Url(sigBuf),
      publicKey: toBase64Url(pubKeyBuf),
      verifiedAt: Date.now(),
    };
  }

  /**
   * High-level helper: verifies a mobile customer's FaceID/TouchID passkey assertion
   * for a direct self-custody transfer and prepares the Soroban smart wallet auth.
   */
  async authorizeSelfCustodyTransfer({
    smartWalletAddress,
    publicKey,
    passkeyAssertion,
    transferDetails,
  }) {
    if (!passkeyAssertion) {
      throw new PasskeyError('Passkey assertion is required', 'MISSING_ASSERTION');
    }

    const { clientDataJSON, authenticatorData, signature } = passkeyAssertion;

    // Verify assertion cryptographically
    const verification = this.verifyAssertion({
      clientDataJSON,
      authenticatorData,
      signature,
      publicKey,
      requireUserVerification: true,
    });

    // Build Soroban smart wallet invocation authorization
    const smartWalletAuth = this.buildSorobanSmartWalletAuth({
      smartWalletAddress,
      clientDataJSON,
      authenticatorData,
      signature,
      publicKey,
    });

    logger.info('passkey_transfer_authorized', {
      smartWalletAddress,
      userVerified: verification.userVerified,
      amount: transferDetails?.amount,
      destination: transferDetails?.destination,
    });

    return {
      authorized: true,
      verification,
      smartWalletAuth,
      transferDetails,
    };
  }

  _purgeExpiredChallenges() {
    const now = Date.now();
    for (const [key, val] of this._challenges.entries()) {
      if (now > val.expiresAt) {
        this._challenges.delete(key);
      }
    }
  }
}

module.exports = {
  PasskeyAdapter,
  PasskeyError,
  ChallengeExpiredError,
  InvalidSignatureError,
  UserVerificationRequiredError,
  normalizeSecp256r1PublicKey,
  toBase64Url,
  toBuffer,
  SECP256R1_SPKI_HEADER_HEX,
};
