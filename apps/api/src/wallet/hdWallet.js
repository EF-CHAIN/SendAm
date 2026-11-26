'use strict';

/**
 * Deterministic Key Derivation (BIP-44 / SLIP-0010 / SEP-0005) for Stellar (#966).
 *
 * Implements hierarchical deterministic (HD) wallet key derivation for Stellar:
 * - Curve: Ed25519 (SLIP-0010)
 * - Coin Type: 148 (SLIP-0044)
 * - Derivation Path: m/44'/148'/<account>'
 * - Mnemonic to Seed: BIP-0039
 */

const crypto = require('crypto');
const { Keypair } = require('@stellar/stellar-sdk');

const ED25519_CURVE_SEED = 'ed25519 seed';
const HARDENED_OFFSET = 0x80000000;
const STELLAR_PURPOSE = 44;
const STELLAR_COIN_TYPE = 148;
const STELLAR_BASE_PATH = `m/${STELLAR_PURPOSE}'/${STELLAR_COIN_TYPE}'`;

/**
 * Normalizes binary seed input into a Buffer.
 *
 * @param {Buffer|string} seed - Binary seed buffer or hex-encoded string
 * @returns {Buffer} Normalized 16-64 byte seed buffer
 */
const normalizeSeed = (seed) => {
  if (Buffer.isBuffer(seed)) {
    if (seed.length < 16) {
      throw new Error('Seed must be at least 16 bytes (128 bits)');
    }
    return seed;
  }

  if (typeof seed === 'string') {
    const clean = seed.trim().toLowerCase();
    if (!/^[0-9a-f]+$/.test(clean) || clean.length < 32 || clean.length % 2 !== 0) {
      throw new Error('Seed string must be a valid hex string of at least 32 hex characters');
    }
    return Buffer.from(clean, 'hex');
  }

  throw new TypeError('Seed must be a Buffer or a hex string');
};

/**
 * Converts a BIP-39 mnemonic phrase into a 64-byte binary seed.
 *
 * @param {string} mnemonic - Space-delimited mnemonic words
 * @param {string} [passphrase=''] - Optional BIP-39 passphrase
 * @returns {Buffer} 64-byte derived seed buffer
 */
const mnemonicToSeed = (mnemonic, passphrase = '') => {
  if (typeof mnemonic !== 'string' || !mnemonic.trim()) {
    throw new TypeError('Mnemonic must be a non-empty string');
  }

  const normalizedMnemonic = mnemonic.trim().normalize('NFKD');
  const salt = `mnemonic${passphrase || ''}`.normalize('NFKD');

  return crypto.pbkdf2Sync(normalizedMnemonic, salt, 2048, 64, 'sha512');
};

/**
 * Derives the master key and chain code from a seed per SLIP-0010.
 *
 * @param {Buffer|string} seed - Master seed
 * @returns {{ key: Buffer, chainCode: Buffer }} Master key and chain code
 */
const deriveMasterKey = (seed) => {
  const seedBuf = normalizeSeed(seed);
  const hmac = crypto.createHmac('sha512', ED25519_CURVE_SEED);
  hmac.update(seedBuf);
  const digest = hmac.digest();

  return {
    key: digest.subarray(0, 32),
    chainCode: digest.subarray(32, 64),
  };
};

/**
 * Derives a child key from a parent key node per SLIP-0010 (Ed25519).
 * Only hardened derivation is supported for Ed25519 curves.
 *
 * @param {{ key: Buffer, chainCode: Buffer }} parentNode - Parent key and chain code
 * @param {number} index - Derivation index (hardened or raw index)
 * @returns {{ key: Buffer, chainCode: Buffer }} Child key and chain code
 */
const deriveChildKey = (parentNode, index) => {
  if (!parentNode || !Buffer.isBuffer(parentNode.key) || !Buffer.isBuffer(parentNode.chainCode)) {
    throw new TypeError('Invalid parent node: key and chainCode buffers required');
  }

  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    throw new TypeError('Child index must be a non-negative integer');
  }

  // Ensure index is hardened for SLIP-0010 Ed25519
  const hardenedIndex = index >= HARDENED_OFFSET ? index : index + HARDENED_OFFSET;

  const ser32 = Buffer.alloc(4);
  ser32.writeUInt32BE(hardenedIndex, 0);

  // Data format for Ed25519: 0x00 || parentKey (32B) || ser32(index) (4B)
  const data = Buffer.concat([Buffer.from([0x00]), parentNode.key, ser32]);

  const hmac = crypto.createHmac('sha512', parentNode.chainCode);
  hmac.update(data);
  const digest = hmac.digest();

  return {
    key: digest.subarray(0, 32),
    chainCode: digest.subarray(32, 64),
  };
};

/**
 * Traverses a derivation path from master seed.
 * Enforces hardened derivation on all Ed25519 segments per SEP-0005.
 *
 * @param {Buffer|string} seed - Master seed
 * @param {string} path - Derivation path string (e.g. "m/44'/148'/0'")
 * @returns {{ key: Buffer, chainCode: Buffer }} Key node at derived path
 */
const derivePath = (seed, path) => {
  if (typeof path !== 'string' || !path.trim()) {
    throw new TypeError('Derivation path must be a non-empty string');
  }

  const cleanPath = path.trim();
  const segments = cleanPath.split('/').filter(Boolean);

  if (segments[0] === 'm') {
    segments.shift();
  }

  let current = deriveMasterKey(seed);

  for (const segment of segments) {
    const isHardened = segment.endsWith("'") || segment.endsWith('h') || segment.endsWith('H');
    if (!isHardened) {
      throw new Error(
        `SLIP-0010 (Ed25519) does not allow non-hardened child derivation: segment "${segment}" must be hardened (e.g. "${segment}'")`
      );
    }

    const indexNumber = parseInt(segment.slice(0, -1), 10);
    if (!Number.isSafeInteger(indexNumber) || indexNumber < 0) {
      throw new Error(`Invalid path segment: "${segment}"`);
    }

    current = deriveChildKey(current, indexNumber);
  }

  return current;
};

/**
 * Derives a Stellar Keypair for an account index from a master seed.
 * Path: m/44'/148'/<accountIndex>'
 *
 * @param {Buffer|string} seed - Master binary seed
 * @param {number} [accountIndex=0] - Account index (default 0)
 * @returns {Keypair} Stellar Keypair instance
 */
const deriveStellarKeypair = (seed, accountIndex = 0) => {
  if (typeof accountIndex !== 'number' || !Number.isSafeInteger(accountIndex) || accountIndex < 0) {
    throw new TypeError('Account index must be a non-negative integer');
  }

  const path = `${STELLAR_BASE_PATH}/${accountIndex}'`;
  const node = derivePath(seed, path);

  return Keypair.fromRawEd25519Seed(node.key);
};

/**
 * Convenience helper to derive a Stellar Keypair directly from a BIP-39 mnemonic.
 *
 * @param {string} mnemonic - Space-separated BIP-39 mnemonic words
 * @param {string} [passphrase=''] - Optional passphrase
 * @param {number} [accountIndex=0] - Account index
 * @returns {Keypair} Derived Stellar Keypair
 */
const deriveFromMnemonic = (mnemonic, passphrase = '', accountIndex = 0) => {
  const seed = mnemonicToSeed(mnemonic, passphrase);
  return deriveStellarKeypair(seed, accountIndex);
};

module.exports = {
  ED25519_CURVE_SEED,
  HARDENED_OFFSET,
  STELLAR_PURPOSE,
  STELLAR_COIN_TYPE,
  STELLAR_BASE_PATH,
  normalizeSeed,
  mnemonicToSeed,
  deriveMasterKey,
  deriveChildKey,
  derivePath,
  deriveStellarKeypair,
  deriveFromMnemonic,
};
