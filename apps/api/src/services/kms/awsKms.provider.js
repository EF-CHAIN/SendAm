// awsKms.provider.js
// Implements an AWS KMS based key provider using the AWS SDK v3.
// Uses CommonJS module syntax as required.

const { KMSClient, GenerateDataKeyCommand, DecryptCommand, DescribeKeyCommand } = require("@aws-sdk/client-kms");
const crypto = require("crypto");

/**
 * Simple policy validator – placeholder for real policy checks.
 * Throws if the supplied policy object is not structurally valid.
 */
function validatePolicy(policy) {
  if (!policy || typeof policy !== "object") {
    throw new Error("Policy must be an object");
  }
  // Very minimal validation – ensure a Statement array exists.
  if (!Array.isArray(policy.Statement)) {
    throw new Error("Policy must contain a Statement array");
  }
  // Add further validation as needed.
}

/**
 * AwsKmsProvider encapsulates common secret‑handling operations.
 */
class AwsKmsProvider {
  /**
   * @param {Object} opts
   * @param {string} opts.keyId – KMS key identifier.
   * @param {string} [opts.region] – AWS region.
   * @param {KMSClient} [opts.client] – Pre‑instantiated client (for testing).
   * @param {string} [opts.keySpec] – Desired data‑key spec (e.g., "AES_256").
   */
  constructor(opts) {
    if (!opts || typeof opts !== "object") {
      throw new Error("Options object required");
    }
    const { keyId, region, client, keySpec } = opts;
    if (!keyId) {
      throw new Error("keyId is required");
    }
    this.keyId = keyId;
    this.region = region;
    this.client = client || new KMSClient({ region });
    this.keySpec = keySpec || "AES_256";
  }

  /** Generate a symmetric data key.
   * @param {Object|Buffer|string} [arg] – Either an encryption context object or options matching crypto.service.js.
   * @returns {Promise<{plaintextKey: Buffer, ciphertextKey: Buffer, encryptedDataKey?: string, keyVersion?: string, keySpec?: string, keyId?: string}>}
   */
  async generateDataKey(arg) {
    let encryptionContext;
    if (arg && typeof arg === "object" && !Buffer.isBuffer(arg)) {
      encryptionContext = arg.encryptionContext;
    } else {
      encryptionContext = arg; // positional argument assumes encryptionContext.
    }
    const cmd = new GenerateDataKeyCommand({
      KeyId: this.keyId,
      KeySpec: this.keySpec,
      EncryptionContext: encryptionContext,
    });
    const resp = await this.client.send(cmd);
    const plaintextKey = Buffer.isBuffer(resp.Plaintext) ? resp.Plaintext : Buffer.from(resp.Plaintext);
    const ciphertextKey = Buffer.isBuffer(resp.CiphertextBlob) ? resp.CiphertextBlob : Buffer.from(resp.CiphertextBlob);
    const result = { plaintextKey, ciphertextKey };
    if (arg && typeof arg === "object" && !Buffer.isBuffer(arg)) {
      if ("keyVersion" in arg) result.keyVersion = arg.keyVersion;
      if ("keySpec" in arg) result.keySpec = arg.keySpec;
      if ("keyId" in arg) result.keyId = arg.keyId;
    }
    // Expose encrypted data key as base64 for compatibility.
    result.encryptedDataKey = ciphertextKey.toString("base64");
    return result;
  }

  /** Decrypt a ciphertext data key.
   * @param {Buffer|string|Object} ciphertextKey – Buffer, base64 string, or options object.
   * @param {Object} [encryptionContext]
   * @returns {Promise<Buffer>} plaintext key
   */
  async decryptDataKey(ciphertextKey, encryptionContext) {
    let keyBlob = ciphertextKey;
    let ctx = encryptionContext;
    if (ciphertextKey && typeof ciphertextKey === "object" && !Buffer.isBuffer(ciphertextKey)) {
      const opts = ciphertextKey;
      if (opts.encryptedDataKey) {
        keyBlob = Buffer.isBuffer(opts.encryptedDataKey)
          ? opts.encryptedDataKey
          : Buffer.from(opts.encryptedDataKey, "base64");
      }
      ctx = opts.encryptionContext;
    }
    const cmd = new DecryptCommand({
      CiphertextBlob: keyBlob,
      EncryptionContext: ctx,
    });
    const resp = await this.client.send(cmd);
    return Buffer.isBuffer(resp.Plaintext) ? resp.Plaintext : Buffer.from(resp.Plaintext);
  }

  /** Encrypt a secret value using a freshly generated data key.
   * @param {Buffer|string} secret – data to protect.
   * @param {Object} [encryptionContext]
   * @returns {Promise<Object>} encrypted payload
   */
  async encryptSecret(secret, encryptionContext) {
    const { plaintextKey, ciphertextKey } = await this.generateDataKey(encryptionContext);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", plaintextKey, iv);
    const secretBuf = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret), "utf8");
    const encrypted = Buffer.concat([cipher.update(secretBuf), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Scrub the plaintext key from memory.
    plaintextKey.fill(0);
    return {
      ciphertext: encrypted,
      iv,
      authTag,
      encryptedDataKey: ciphertextKey,
    };
  }

  /** Decrypt a secret previously encrypted with {@link encryptSecret}.
   * @param {Object} payload – the object returned by encryptSecret.
   * @param {Object} [encryptionContext]
   * @returns {Promise<Buffer>} plaintext secret
   */
  async decryptSecret(payload, encryptionContext) {
    const { ciphertext, iv, authTag, encryptedDataKey } = payload;
    const plaintextKey = await this.decryptDataKey(encryptedDataKey, encryptionContext);
    const decipher = crypto.createDecipheriv("aes-256-gcm", plaintextKey, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    // Zero the plaintext key now that it is no longer needed.
    plaintextKey.fill(0);
    return decrypted;
  }

  /** Describe the configured key – optional utility. */
  async describeKey() {
    const cmd = new DescribeKeyCommand({ KeyId: this.keyId });
    return await this.client.send(cmd);
  }
}

/** Factory function – validates required options and returns a provider.
 * @param {Object} opts – same shape as AwsKmsProvider constructor.
 */
function createAwsKmsProvider(opts) {
  if (!opts || typeof opts !== "object") {
    throw new Error("Options object required");
  }
  if (!opts.keyId) {
    throw new Error("Option 'keyId' is required");
  }
  if (opts.policy) {
    validatePolicy(opts.policy);
  }
  return new AwsKmsProvider(opts);
}

module.exports = {
  AwsKmsProvider,
  createAwsKmsProvider,
  validatePolicy,
};
