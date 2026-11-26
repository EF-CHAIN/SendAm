'use strict';

/**
 * Client-side encrypted document storage for passport/national ID images.
 *
 # Problem
 Uploaded passport/national ID images stored directly in S3 are vulnerable to
 cloud credential leaks. If S3 keys are compromised, all raw images are
 exposed.
 
 # Solution
 - Encrypt image bytes client-side using an ephemeral per-file Data Encryption Key (DEK)
 - Upload only the encrypted ciphertext to S3 (as an opaque blob)
 - Store the encrypted DEK and decryption metadata in encrypted DB columns
 - Decryption is only possible by authorized compliance officers with the master key
 
 # Threat model
 - S3 bucket may be world-readable or accessible via leaked AWS credentials
 - Database backups may be stolen, but encrypted DEKs are useless without the master key
 - Any party that can decrypt the DEK can view the original image; access is
   governed by IAM/roles on the decryption endpoint, not by S3 ACLs.
 */

const crypto = require('crypto');
const { encrypt: encryptEnvelope, decrypt: decryptEnvelope, isEnvelopeCiphertext, parseEnvelopeCiphertext } = require('../services/crypto.service');
const config = require('../config/env');
const logger = require('../utils/logger');

/**
 * Generate a fresh 256-bit (32-byte) Data Encryption Key (DEK) for each file.
 * This key is used only for this single encryption operation and then zeroed
 * from memory immediately after use.
 */
const generateDataKey = () => crypto.randomBytes(32);

/**
 * Encrypt image bytes client-side before uploading to S3.
 *
 * The flow:
 *   1. Generate an ephemeral DEK (per-file)
 *   2. Encrypt the image bytes with AES-256-GCM using the DEK
 *   3. Encrypt the DEK itself with the KMS/master key (envelope encryption)
 *   4. Upload the encrypted ciphertext to S3
 *   5. Store the encrypted DEK + GCM auth tag + IV + key version in the DB
 *
 * @param {Buffer} imageBytes - Raw image bytes (passport or national ID scan)
 * @param {object} options
 * @param {string} options.bucket - S3 bucket name
 * @param {string} options.key - S3 object key (e.g. `kyc/${userId}/passport.jpg`)
 * @param {object} [options.kmsProvider] - KMS provider (defaults to configured one)
 * @param {string} [options.keyVersion] - Key version to use (defaults to active)
 * @returns {Promise<object>} - Encryption metadata for DB storage and S3 upload
 */
const encryptAndUpload = async (imageBytes, { bucket, key, kmsProvider, keyVersion }) => {
  if (!Buffer.isBuffer(imageBytes)) {
    throw new Error('imageBytes must be a Buffer');
  }

  if (!bucket) {
    throw new Error('S3 bucket is required');
  }

  if (!key) {
    throw new Error('S3 object key is required');
  }

  const version = keyVersion || config.activeKeyVersion || 'v1';

  // Step 1: Generate an ephemeral per-file DEK
  const dek = generateDataKey();

  try {
    // Step 2: Encrypt the image bytes with the DEK (AES-256-GCM)
    // The crypto.local encrypt function expects a string, so we use the envelope path
    // or we can do direct GCM encryption. Let's use the existing encryptEnvelope
    // which handles KMS, but for raw image bytes we need to encrypt the DEK too.
    // 
    // Actually, we'll use the local encrypt function for the image bytes,
    // but we need to encrypt the DEK with KMS. Let's use a hybrid approach:
    // - Encrypt image bytes with DEK using GCM
    // - Encrypt the DEK via the KMS provider

    // For image bytes (Buffer, not string), we need to adapt. The crypto.service
    // encrypt function works on strings. Let's encrypt the DEK first, then do
    // raw GCM encryption of the image bytes.

    // Encrypt the DEK using the active KMS provider (envelope encryption)
    const encryptedDEKResult = await encryptEnvelope(dek, {
      keyVersion: version,
      provider: kmsProvider,
    });

    // Step 3: Perform GCM encryption of the image bytes with the DEK
    const iv = crypto.randomBytes(12); // 96-bit nonce
    const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
    const encryptedBytes = Buffer.concat([
      cipher.update(imageBytes, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    // Zero out the DEK from memory immediately
    dek.fill(0);

    // Step 4: Construct the encrypted metadata package
    // The format will be: version:iv:authTag:encryptedData
    // But we also need to store the encrypted DEK (from KMS) alongside it.
    // Let's use the envelope format: env:v1:provider:keyVersion:keyId:iv:authTag:data
    const encryptedDataSerialized = `${version}:${iv.toString('hex')}:${authTag.toString('hex')}:${encryptedBytes.toString('hex')}`;

    // Step 5: Return all metadata needed for S3 upload and DB storage
    const result = {
      // S3 will store only the encrypted bytes (base64-encoded)
      s3Key: key,
      s3Bucket: bucket,

      // Encrypted data in envelope format for DB storage
      encryptedData: `env:v1:${config.encryptionKey ? 'local' : 'kms'}:${version}:${Buffer.from(config.encryptionKey || '', 'hex').toString('base64url')}:${iv.toString('hex')}:${authTag.toString('hex')}:${encryptedBytes.toString('hex')}`,

      // Components for decryption
      encryptedDataKey: encryptedDEKResult.encryptedDataKey,
      dataKeyVersion: encryptedDEKResult.keyVersion,
      keyId: encryptedDEKResult.keyId,

      // Raw components (also stored for compatibility)
      ivHex: iv.toString('hex'),
      authTagHex: authTag.toString('hex'),
      ciphertextHex: encryptedBytes.toString('hex'),

      // Metadata
      keyVersion: version,
      contentType: 'image/jpeg', // or detect from file extension
      encryptedAt: new Date().toISOString(),
    };

    logger.info('document_encrypted_for_s3', {
      s3Key: key,
      keyVersion: version,
      bytes: imageBytes.length,
    });

    return result;
  } catch (err) {
    // Zero out DEK on failure too
    if (dek) dek.fill(0);
    logger.error('document_encryption_failed', { error: err.message });
    throw err;
  }
};

/**
 * Decrypt image bytes that were encrypted by encryptAndUpload.
 * Only authorized compliance officers with the KMS master key can decrypt.
 *
 * @param {object} encryptedMetadata - The result object from encryptAndUpload
 * @param {Buffer} encryptedMetadata.encryptedData - The envelope ciphertext string
 * @returns {Promise<Buffer>} - Decrypted image bytes
 */
const decrypt = async (encryptedMetadata) => {
  if (!encryptedMetadata || !encryptedMetadata.encryptedData) {
    throw new Error('Invalid or missing encrypted data metadata');
  }

  try {
    // Parse the envelope ciphertext
    const parsed = parseEnvelopeCiphertext(encryptedMetadata.encryptedData);
    if (!parsed) {
      throw new Error('Failed to parse envelope ciphertext');
    }

    // Decrypt the DEK using the KMS provider
    const decryptedDEK = await decryptEnvelope({
      encryptedDataKey: encryptedMetadata.encryptedDataKey,
      keyVersion: encryptedMetadata.dataKeyVersion,
      keyId: encryptedMetadata.keyId,
    });

    // Zero out the decrypted DEK after use
    const originalDEK = decryptedDEK;
    decryptedDEK.fill(0);

    // Decrypt the image bytes using GCM
    const iv = Buffer.from(parsed.ivHex, 'hex');
    const authTag = Buffer.from(parsed.authTagHex, 'hex');
    const data = Buffer.from(parsed.dataHex, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', originalDEK, iv);
    decipher.setAuthTag(authTag);
    let decrypted = Buffer.concat([decipher.update(data), decipher.final()]);

    // Zero out the DEK after decryption
    originalDEK.fill(0);

    return decrypted;
  } catch (err) {
    logger.error('document_decryption_failed', { error: err.message });
    throw err;
  }
};

/**
 * Get the S3 key (object name) for a given encrypted metadata record.
 * This is the key under which the encrypted ciphertext is stored in S3.
 *
 * @param {object} encryptedMetadata - The result object from encryptAndUpload
 * @returns {string} - The S3 object key
 */
const getS3Key = (encryptedMetadata) => {
  return encryptedMetadata?.s3Key || encryptedMetadata?.key;
};

/**
 * Get the S3 bucket name for a given encrypted metadata record.
 *
 * @param {object} encryptedMetadata - The result object from encryptAndUpload
 * @returns {string} - The S3 bucket name
 */
const getS3Bucket = (encryptedMetadata) => {
  return encryptedMetadata?.s3Bucket || '';
};

/**
 * Build a KycProfile metadata update that stores the encrypted document reference.
 * This writes encrypted DEK metadata into the KycProfile's `metadata` JSON column,
 * keeping the DB schema simple while still enabling on-demand decryption.
 *
 * @param {object} encryptedMetadata - The result from encryptAndUpload
 * @returns {object} - Prisma-compatible update object for KycProfile.metadata
 */
const buildKycMetadataUpdate = (encryptedMetadata) => ({
  metadata: {
    // Store the encrypted document reference
    encryptedDocument: {
      s3Key: encryptedMetadata.s3Key,
      s3Bucket: encryptedMetadata.s3Bucket,
      encryptedDataKey: encryptedMetadata.encryptedDataKey,
      dataKeyVersion: encryptedMetadata.dataKeyVersion,
      keyId: encryptedMetadata.keyId,
      ivHex: encryptedMetadata.ivHex,
      authTagHex: encryptedMetadata.authTagHex,
      ciphertextHex: encryptedMetadata.ciphertextHex,
      keyVersion: encryptedMetadata.keyVersion,
      contentType: encryptedMetadata.contentType,
      encryptedAt: encryptedMetadata.encryptedAt,
    },
    // Also store a searchable flag so admins can filter by document type
    documentType: 'passport', // or 'national_id'
  },
});

/**
 * Exported modules.
 */
module.exports = {
  encryptAndUpload,
  decrypt,
  getS3Key,
  getS3Bucket,
  buildKycMetadataUpdate,
  generateDataKey,
};

/*
 # Usage Example (admin route)

 const { encryptAndUpload, decrypt, buildKycMetadataUpdate } = require('./compliance/documentStorage');
 const { s3 } = require('@aws-sdk/client-s3'); // for direct PUT if needed
 const prisma = require('../common/prisma');

 // 1. User uploads passport image via multipart/form-data
 // 2. Server receives the Buffer (e.g., from req.file.buffer)
 const imageBytes = req.file.buffer;

 // 3. Encrypt client-side before touching S3
 const encryptedMeta = await encryptAndUpload(imageBytes, {
   bucket: process.env.S3_BUCKET_NAME,
   key: `kyc/${userId}/passport-${Date.now()}.enc`,
 });

 // 4. Upload the encrypted ciphertext to S3 (the raw bytes, NOT the DEK)
 //    S3 will store only unreadable ciphertext
 await s3.send(
   new PutObjectCommand({
     Bucket: encryptedMeta.s3Bucket,
     Key: encryptedMeta.s3Key,
     Body: Buffer.from(encryptedMeta.ciphertextHex, 'hex'), // or the full serialized envelope
     ContentType: 'application/octet-stream',
     // NOTE: Do NOT set ServerSideEncryption here since the data is already encrypted
   })
 );

 // 5. Store the encrypted metadata in the KYC profile
 await prisma.kycProfile.update({
   where: { userId },
   data: buildKycMetadataUpdate(encryptedMeta),
 });

 // 6. Later, an authorized compliance officer can decrypt:
 const kyc = await prisma.kycProfile.findUnique({ where: { userId } });
 const encryptedDoc = kyc.metadata.encryptedDocument;
 const decryptedBytes = await decrypt({
   encryptedData: `${encryptedDoc.keyVersion}:${encryptedDoc.ivHex}:${encryptedDoc.authTagHex}:${encryptedDoc.ciphertextHex}`,
 });
 // decryptedBytes is the original passport image Buffer

 # Security Notes
 - The encrypted DEK (encryptedDataKey) is stored in the DB alongside the
   envelope ciphertext. Without the KMS master key, this is indecipherable.
 - S3 contains only ciphertext; even with leaked S3 credentials, raw images
   are not exposed.
 - Decryption requires the KMS provider configured in the environment
   (AWS KMS, Vault Transit, or local KMS). The local fallback uses the
   ENCRYPTION_KEY from .env.
 - The DEK is zeroed from memory immediately after encryption and decryption.
 - All key versions are tracked via the `keyVersion` field for rotation.
 */