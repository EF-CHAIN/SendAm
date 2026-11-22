'use strict';

const { createAwsKmsProvider, AWS_KMS_ERROR_CODES } = require('./awsKms.provider');
const { createVaultTransitProvider, VAULT_ERROR_CODES } = require('./vaultTransit.provider');

/**
 * Creates a KMS provider instance from configuration / environment variables.
 * Supported providers: 'aws' | 'vault' | 'local' (returns null so crypto.service uses its local default).
 */
const createKmsProvider = (providerName, options = {}) => {
  const normalized = String(providerName || process.env.KMS_PROVIDER || 'local').toLowerCase().trim();

  if (normalized === 'aws' || normalized === 'aws-kms') {
    return createAwsKmsProvider(options);
  }

  if (normalized === 'vault' || normalized === 'vault-transit') {
    return createVaultTransitProvider(options);
  }

  if (normalized === 'local' || normalized === 'local-kms') {
    return null;
  }

  throw new Error(`Unsupported KMS provider: '${providerName}'. Supported providers are local, aws, and vault.`);
};

module.exports = {
  createKmsProvider,
  createAwsKmsProvider,
  createVaultTransitProvider,
  AWS_KMS_ERROR_CODES,
  VAULT_ERROR_CODES,
};
