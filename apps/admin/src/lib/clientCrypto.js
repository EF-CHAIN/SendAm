/**
 * Client-side encryption utility for sensitive compliance and KYC data exports
 * using the Web Cryptography API (crypto.subtle).
 *
 * Employs AES-256-GCM with PBKDF2 key derivation (100,000 iterations, SHA-256)
 * and exports formatted encrypted archives with metadata headers (.sendam-enc format).
 */

const PBKDF2_ITERATIONS = 100000;
const HASH_ALGO = "SHA-256";
const KEY_LENGTH = 256;
const SALT_BYTES = 16;
const IV_BYTES = 12; // Standard 96-bit IV for AES-GCM

/**
 * Derives an AES-GCM CryptoKey from a passphrase and salt using PBKDF2.
 *
 * @param {string} passphrase
 * @param {Uint8Array} salt
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKey(passphrase, salt) {
  if (!passphrase || typeof passphrase !== "string") {
    throw new Error("Passphrase is required and must be a string");
  }
  if (!salt || !(salt instanceof Uint8Array) || salt.length < 16) {
    throw new Error("Valid salt of at least 16 bytes is required");
  }

  const subtle = window.crypto?.subtle || globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "Web Cryptography API (crypto.subtle) is not available in this environment",
    );
  }

  const enc = new TextEncoder();
  const passphraseKey = await subtle.importKey(
    "raw",
    enc.encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );

  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: HASH_ALGO,
    },
    passphraseKey,
    {
      name: "AES-GCM",
      length: KEY_LENGTH,
    },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Converts ArrayBuffer or Uint8Array to base64 string.
 */
function toBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Converts base64 string to Uint8Array.
 */
function fromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encrypts plaintext data using AES-256-GCM and PBKDF2 key derivation.
 *
 * @param {string|Uint8Array|ArrayBuffer} data - Plaintext content (e.g. JSON string or CSV data)
 * @param {string} passphrase - Secret password supplied by operator
 * @param {Object} [metadata={}] - Optional metadata to include in header
 * @returns {Promise<{
 *   version: string,
 *   format: string,
 *   algorithm: string,
 *   kdf: { name: string, iterations: number, hash: string, salt: string },
 *   iv: string,
 *   ciphertext: string,
 *   metadata: Object,
 *   timestamp: string
 * }>}
 */
export async function encryptData(data, passphrase, metadata = {}) {
  if (!passphrase) {
    throw new Error("Decryption passphrase is required");
  }

  const cryptoObj = window.crypto || globalThis.crypto;
  const subtle = cryptoObj?.subtle;
  if (!subtle) {
    throw new Error("Web Cryptography API is not supported");
  }

  const salt = new Uint8Array(SALT_BYTES);
  const iv = new Uint8Array(IV_BYTES);
  cryptoObj.getRandomValues(salt);
  cryptoObj.getRandomValues(iv);

  const key = await deriveKey(passphrase, salt);

  let rawBytes;
  if (typeof data === "string") {
    rawBytes = new TextEncoder().encode(data);
  } else if (data instanceof Uint8Array) {
    rawBytes = data;
  } else if (data instanceof ArrayBuffer) {
    rawBytes = new Uint8Array(data);
  } else if (typeof data === "object" && data !== null) {
    rawBytes = new TextEncoder().encode(JSON.stringify(data));
  } else {
    throw new Error("Invalid data type for encryption");
  }

  const encryptedBuffer = await subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
    },
    key,
    rawBytes,
  );

  return {
    version: "1.0",
    format: "sendam-enc",
    algorithm: "AES-256-GCM",
    kdf: {
      name: "PBKDF2",
      iterations: PBKDF2_ITERATIONS,
      hash: HASH_ALGO,
      salt: toBase64(salt),
    },
    iv: toBase64(iv),
    ciphertext: toBase64(encryptedBuffer),
    metadata: {
      ...metadata,
      createdAt: new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Decrypts a .sendam-enc encrypted payload using the provided passphrase.
 *
 * @param {Object|string} encryptedPayload - JSON object or string conforming to .sendam-enc format
 * @param {string} passphrase - Operator passphrase
 * @returns {Promise<string>} Decrypted plaintext string
 */
export async function decryptData(encryptedPayload, passphrase) {
  if (!passphrase) {
    throw new Error("Passphrase is required for decryption");
  }

  const payload =
    typeof encryptedPayload === "string"
      ? JSON.parse(encryptedPayload)
      : encryptedPayload;

  if (payload.format !== "sendam-enc") {
    throw new Error("Unsupported encrypted payload format");
  }

  const subtle = window.crypto?.subtle || globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Cryptography API is not supported");
  }

  const salt = fromBase64(payload.kdf.salt);
  const iv = fromBase64(payload.iv);
  const ciphertext = fromBase64(payload.ciphertext);

  const key = await deriveKey(passphrase, salt);

  const decryptedBuffer = await subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
    },
    key,
    ciphertext,
  );

  return new TextDecoder().decode(decryptedBuffer);
}

/**
 * Creates and triggers a download of a .sendam-enc file in the browser.
 *
 * @param {Object} encryptedData - Encrypted payload object
 * @param {string} [filename='kyc-export.sendam-enc'] - Target filename
 */
export function downloadEncryptedFile(
  encryptedData,
  filename = "kyc-export.sendam-enc",
) {
  const jsonString = JSON.stringify(encryptedData, null, 2);
  const blob = new Blob([jsonString], { type: "application/json" });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}
