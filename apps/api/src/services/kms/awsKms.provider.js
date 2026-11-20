'use strict';

const {
  KMSClient,
  GenerateDataKeyCommand,
  DecryptCommand,
  DescribeKeyCommand,
} = require('@aws-sdk/client-kms');
const logger = require('../../utils/logger');

const DEFAULT_KEY_SPEC = 'AES_256';
const EXPECTED_DEK_BYTES = 32;

const AWS_KMS_ERROR_CODES = Object.freeze({
  ACCESS_DENIED: 'KMS_ACCESS_DENIED',
  INVALID_STATE: 'KMS_INVALID_KEY_STATE',
  INVALID_CIPHERTEXT: 'KMS_INVALID_CIPHERTEXT',
  NOT_FOUND: 'KMS_KEY_NOT_FOUND',
  DISABLED: 'KMS_KEY_DISABLED',
  KEY_MISMATCH: 'KMS_KEY_ID_MISMATCH',
  MISCONFIGURED: 'KMS_MISCONFIGURED',
  PROVIDER_ERROR: 'KMS_PROVIDER_ERROR',
});

const redactSecretMaterial = (message) => String(message || 'AWS KMS operation failed')
  .replace(/S[A-Z2-7]{55}/g, '[REDACTED_SECRET]')
  .replace(/[0-9a-fA-F]{64}/g, '[REDACTED_HEX]');

const classifyAwsKmsError = (error, operation) => {
  const errName = error?.name || error?.Code || '';
  const safeMsg = redactSecretMaterial(error?.message);

  if (errName === 'AccessDeniedException' || /not authorized|access denied/i.test(safeMsg)) {
    return Object.assign(
      new Error(`AWS KMS IAM policy denied ${operation}: ${safeMsg}`),
      { code: AWS_KMS_ERROR_CODES.ACCESS_DENIED, retryable: false, statusCode: 403, cause: error },
    );
  }

  if (errName === 'KMSInvalidStateException') {
    return Object.assign(
      new Error(`AWS KMS key is in an invalid state for ${operation}: ${safeMsg}`),
      { code: AWS_KMS_ERROR_CODES.INVALID_STATE, retryable: false, statusCode: 500, cause: error },
    );
  }

  if (errName === 'DisabledException') {
    return Object.assign(
      new Error(`AWS KMS key is disabled for ${operation}: ${safeMsg}`),
      { code: AWS_KMS_ERROR_CODES.DISABLED, retryable: false, statusCode: 500, cause: error },
    );
  }

  if (errName === 'InvalidCiphertextException') {
    return Object.assign(
      new Error(`AWS KMS ciphertext or encryption context validation failed during ${operation}`),
      { code: AWS_KMS_ERROR_CODES.INVALID_CIPHERTEXT, retryable: false, statusCode: 400, cause: error },
    );
  }

  if (errName === 'NotFoundException') {
    return Object.assign(
      new Error(`AWS KMS key not found during ${operation}: ${safeMsg}`),
      { code: AWS_KMS_ERROR_CODES.NOT_FOUND, retryable: false, statusCode: 404, cause: error },
    );
  }

  const retryable = Boolean(error?.$retryable) || /throttl|timeout|temporarily unavailable/i.test(safeMsg);
  return Object.assign(
    new Error(`AWS KMS ${operation} failed: ${safeMsg}`),
    { code: AWS_KMS_ERROR_CODES.PROVIDER_ERROR, retryable, statusCode: 502, cause: error },
  );
};

const normalizeEncryptionContext = (baseContext, extraContext, keyVersion) => {
  const merged = {};
  const sources = [baseContext, extraContext];
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(src)) {
      if (v !== undefined && v !== null) {
        merged[String(k)] = String(v);
      }
    }
  }
  if (keyVersion) {
    merged.keyVersion = String(keyVersion);
  }
  return merged;
};

const toBuffer = (value, label) => {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string' && value.length > 0) {
    return Buffer.from(value, 'base64');
  }
  throw Object.assign(new Error(`${label} must be a non-empty Buffer, Uint8Array, or base64 string.`), {
    code: AWS_KMS_ERROR_CODES.INVALID_CIPHERTEXT,
    retryable: false,
  });
};

/**
 * Creates an AWS KMS envelope encryption provider backed by `@aws-sdk/client-kms`.
 *
 * Master encryption keys (CMKs) never leave AWS KMS. Each `generateDataKey` call
 * asks KMS for a fresh 256-bit data encryption key (DEK) and its KMS-encrypted
 * ciphertext blob; callers encrypt secrets locally with AES-256-GCM, store the
 * encrypted DEK and CMK key ID alongside the ciphertext, and zero the plaintext DEK.
 */
const createAwsKmsProvider = ({
  region = process.env.AWS_KMS_REGION || process.env.AWS_REGION,
  keyId = process.env.AWS_KMS_KEY_ID,
  keyVersionMap = {},
  endpoint = process.env.AWS_KMS_ENDPOINT || undefined,
  encryptionContext = { service: 'sendam-api' },
  enforceKeyIdMatch = true,
  kmsClient = null,
  credentials = undefined,
} = {}) => {
  const client = kmsClient || new KMSClient({
    region: region || 'us-east-1',
    ...(endpoint ? { endpoint } : {}),
    ...(credentials ? { credentials } : {}),
  });

  const versionMap = new Map(Object.entries(keyVersionMap || {}));

  const resolveKeyId = (requestedKeyId, keyVersion) => {
    const resolved = requestedKeyId
      || (keyVersion && versionMap.get(keyVersion))
      || keyId;

    if (!resolved || typeof resolved !== 'string' || !resolved.trim()) {
      throw Object.assign(
        new Error('AWS KMS keyId is required (configure AWS_KMS_KEY_ID or pass keyId/keyVersionMap).'),
        { code: AWS_KMS_ERROR_CODES.MISCONFIGURED, retryable: false },
      );
    }
    return resolved.trim();
  };

  const registerKeyIdForVersion = (version, cmkKeyId) => {
    if (!version || !cmkKeyId) {
      throw new Error('Both version and cmkKeyId are required.');
    }
    versionMap.set(String(version), String(cmkKeyId));
  };

  /**
   * Generates a 256-bit Data Encryption Key (DEK) using a remote AWS KMS CMK.
   * Returns `{ plaintextKey: Buffer, encryptedDataKey: string (base64), keyId: string, keyVersion: string }`.
   */
  const generateDataKey = async ({
    keyVersion = 'v1',
    keyId: requestedKeyId = null,
    encryptionContext: extraContext = null,
    keySpec = DEFAULT_KEY_SPEC,
  } = {}) => {
    const resolvedKeyId = resolveKeyId(requestedKeyId, keyVersion);
    const context = normalizeEncryptionContext(encryptionContext, extraContext, keyVersion);

    const command = new GenerateDataKeyCommand({
      KeyId: resolvedKeyId,
      KeySpec: keySpec,
      EncryptionContext: context,
    });

    let response;
    try {
      response = await client.send(command);
    } catch (error) {
      logger.error('aws_kms_generate_data_key_failed', {
        keyVersion,
        keyId: resolvedKeyId,
        errorName: error?.name || 'Error',
      });
      throw classifyAwsKmsError(error, 'GenerateDataKey');
    }

    if (!response?.Plaintext || !response?.CiphertextBlob) {
      throw Object.assign(
        new Error('AWS KMS GenerateDataKey returned incomplete key material.'),
        { code: AWS_KMS_ERROR_CODES.PROVIDER_ERROR, retryable: false },
      );
    }

    const plaintextKey = Buffer.from(response.Plaintext);
    if (plaintextKey.length !== EXPECTED_DEK_BYTES) {
      plaintextKey.fill(0);
      throw Object.assign(
        new Error(`Unexpected DEK length from AWS KMS: expected ${EXPECTED_DEK_BYTES} bytes, got ${plaintextKey.length}.`),
        { code: AWS_KMS_ERROR_CODES.PROVIDER_ERROR, retryable: false },
      );
    }

    const encryptedDataKey = Buffer.from(response.CiphertextBlob).toString('base64');
    const resolvedArnOrId = response.KeyId || resolvedKeyId;

    return {
      plaintextKey,
      encryptedDataKey,
      keyId: resolvedArnOrId,
      keyVersion,
      encryptionContext: context,
    };
  };

  /**
   * Decrypts a KMS-encrypted Data Encryption Key (DEK) via AWS KMS Decrypt API.
   * Validates IAM authorization, encryption context, and optional CMK key ID match.
   * Returns a 32-byte Buffer containing the plaintext DEK.
   */
  const decryptDataKey = async ({
    encryptedDataKey,
    keyVersion = 'v1',
    keyId: requestedKeyId = null,
    encryptionContext: extraContext = null,
  } = {}) => {
    const ciphertextBlob = toBuffer(encryptedDataKey, 'encryptedDataKey');
    const expectedKeyId = requestedKeyId || (keyVersion && versionMap.get(keyVersion)) || keyId || undefined;
    const context = normalizeEncryptionContext(encryptionContext, extraContext, keyVersion);

    const command = new DecryptCommand({
      CiphertextBlob: ciphertextBlob,
      ...(expectedKeyId ? { KeyId: expectedKeyId } : {}),
      EncryptionContext: context,
    });

    let response;
    try {
      response = await client.send(command);
    } catch (error) {
      logger.error('aws_kms_decrypt_data_key_failed', {
        keyVersion,
        keyId: expectedKeyId || null,
        errorName: error?.name || 'Error',
      });
      throw classifyAwsKmsError(error, 'Decrypt');
    }

    if (!response?.Plaintext) {
      throw Object.assign(
        new Error('AWS KMS Decrypt returned no plaintext key.'),
        { code: AWS_KMS_ERROR_CODES.PROVIDER_ERROR, retryable: false },
      );
    }

    if (enforceKeyIdMatch && expectedKeyId && response.KeyId && response.KeyId !== expectedKeyId) {
      // Allow alias/key-id suffix match against full ARN while rejecting unrelated CMKs.
      const isArnMatch = response.KeyId.endsWith(`/${expectedKeyId}`) || response.KeyId.endsWith(`:${expectedKeyId}`);
      if (!isArnMatch) {
        const tmp = Buffer.from(response.Plaintext);
        tmp.fill(0);
        throw Object.assign(
          new Error(`AWS KMS decrypted DEK with unexpected KeyId: expected ${expectedKeyId}, got ${response.KeyId}.`),
          { code: AWS_KMS_ERROR_CODES.KEY_MISMATCH, retryable: false, statusCode: 403 },
        );
      }
    }

    const plaintextKey = Buffer.from(response.Plaintext);
    if (plaintextKey.length !== EXPECTED_DEK_BYTES) {
      plaintextKey.fill(0);
      throw Object.assign(
        new Error(`Unexpected decrypted DEK length from AWS KMS: expected ${EXPECTED_DEK_BYTES} bytes, got ${plaintextKey.length}.`),
        { code: AWS_KMS_ERROR_CODES.PROVIDER_ERROR, retryable: false },
      );
    }

    return plaintextKey;
  };

  /**
   * Validates IAM permissions and enabled state for a CMK using DescribeKey.
   */
  const validateKeyAccess = async ({ keyId: requestedKeyId = null, keyVersion = 'v1' } = {}) => {
    const resolvedKeyId = resolveKeyId(requestedKeyId, keyVersion);
    const command = new DescribeKeyCommand({ KeyId: resolvedKeyId });

    let response;
    try {
      response = await client.send(command);
    } catch (error) {
      throw classifyAwsKmsError(error, 'DescribeKey');
    }

    const metadata = response?.KeyMetadata;
    if (!metadata || metadata.Enabled === false || metadata.KeyState !== 'Enabled') {
      throw Object.assign(
        new Error(`AWS KMS key ${resolvedKeyId} is not enabled (state: ${metadata?.KeyState || 'unknown'}).`),
        { code: AWS_KMS_ERROR_CODES.DISABLED, retryable: false },
      );
    }

    return {
      keyId: metadata.KeyId || resolvedKeyId,
      arn: metadata.Arn || null,
      keyState: metadata.KeyState,
      enabled: Boolean(metadata.Enabled),
    };
  };

  return {
    name: 'aws-kms',
    generateDataKey,
    decryptDataKey,
    validateKeyAccess,
    registerKeyIdForVersion,
    resolveKeyId,
  };
};

module.exports = {
  AWS_KMS_ERROR_CODES,
  createAwsKmsProvider,
  classifyAwsKmsError,
};
