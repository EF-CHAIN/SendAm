'use strict';

// Soroban RPC & smart contract configuration (#931).
//
// Validates network passphrase coherence between the configured Stellar network
// profile (`testnet` / `public`) and any explicit `SOROBAN_NETWORK_PASSPHRASE`
// or RPC endpoint configuration. Also centralizes contract ID resolution and
// StrKey validation (`C...` 56-character contract addresses).

const { StellarSdk } = require('./stellar');
const config = require('./env');
const {
  NETWORK_PROFILES,
  normalizeNetworkId,
} = require('./networkProfiles');

const TESTNET_SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
const MAINNET_SOROBAN_RPC_URL = 'https://mainnet.sorobanrpc.com';

const DEFAULT_SOROBAN_RPC_URLS = Object.freeze({
  testnet: TESTNET_SOROBAN_RPC_URL,
  public: MAINNET_SOROBAN_RPC_URL,
});

const SOROBAN_NETWORK_PASSPHRASES = Object.freeze({
  testnet: NETWORK_PROFILES.testnet.passphrase,
  public: NETWORK_PROFILES.public.passphrase,
});

/**
 * Validate whether a string is a valid 56-character Soroban Contract StrKey (`C...`).
 *
 * @param {unknown} value - Candidate contract address.
 * @returns {boolean} True if valid Soroban contract StrKey.
 */
const isContractStrkey = (value) => {
  if (typeof value !== 'string' || value.length !== 56 || !/^C[A-Z2-7]{55}$/.test(value)) {
    return false;
  }
  try {
    if (StellarSdk?.StrKey?.isValidContract) {
      return StellarSdk.StrKey.isValidContract(value);
    }
    return true;
  } catch (_err) {
    return false;
  }
};

/**
 * Validate that a network identifier and network passphrase match the canonical
 * Stellar / Soroban network profile.
 *
 * @param {object} options
 * @param {string} options.network - Network name or alias (e.g. 'testnet', 'mainnet', 'public').
 * @param {string} [options.networkPassphrase] - Expected or RPC-reported network passphrase.
 * @param {boolean} [options.allowMainnet=false] - Explicit confirmation required when targeting mainnet.
 * @returns {{ valid: boolean, networkId: string | null, expectedPassphrase: string | null, problems: string[] }}
 */
const validateSorobanNetworkPassphrase = ({
  network,
  networkPassphrase,
  allowMainnet = false,
} = {}) => {
  const problems = [];
  const networkId = normalizeNetworkId(network);

  if (!networkId) {
    problems.push(
      `Invalid Soroban network ${JSON.stringify(network)}. Expected 'testnet' or 'mainnet'/'public'.`,
    );
    return {
      valid: false,
      networkId: null,
      expectedPassphrase: null,
      problems,
    };
  }

  const profile = NETWORK_PROFILES[networkId];
  const expectedPassphrase = profile.passphrase;

  if (profile.isMainnet && !allowMainnet) {
    problems.push(
      `Soroban deployment targets ${profile.label}, which requires STELLAR_ALLOW_MAINNET=true.`,
    );
  }

  if (networkPassphrase !== undefined && networkPassphrase !== null && networkPassphrase !== '') {
    if (networkPassphrase !== expectedPassphrase) {
      problems.push(
        `Soroban network passphrase mismatch for ${profile.label}: expected ${JSON.stringify(expectedPassphrase)}, got ${JSON.stringify(networkPassphrase)}.`,
      );
    }
  }

  return {
    valid: problems.length === 0,
    networkId,
    expectedPassphrase,
    problems,
  };
};

/**
 * Assert that the Soroban network and passphrase are valid and coherent.
 * Throws a descriptive Error if validation fails.
 *
 * @param {object} options
 * @returns {{ networkId: string, expectedPassphrase: string }}
 */
const assertSorobanNetworkPassphrase = (options = {}) => {
  const result = validateSorobanNetworkPassphrase(options);
  if (!result.valid) {
    throw new Error(`Invalid Soroban network configuration:\n  - ${result.problems.join('\n  - ')}`);
  }
  return {
    networkId: result.networkId,
    expectedPassphrase: result.expectedPassphrase,
  };
};

/**
 * Build the resolved Soroban configuration object from environment variables
 * and base application config.
 *
 * @param {object} [envVars=process.env] - Environment variable map.
 * @param {object} [appConfig=config] - Application config object.
 * @returns {object} Resolved Soroban configuration.
 */
const resolveSorobanConfig = (envVars = process.env, appConfig = config) => {
  const rawNetwork = envVars.SOROBAN_NETWORK || envVars.STELLAR_NETWORK || appConfig?.stellar?.network || 'testnet';
  const networkId = normalizeNetworkId(rawNetwork) || 'testnet';
  const allowMainnet = String(envVars.STELLAR_ALLOW_MAINNET || appConfig?.stellar?.allowMainnet || '').toLowerCase() === 'true';

  const defaultRpcUrl = DEFAULT_SOROBAN_RPC_URLS[networkId] || TESTNET_SOROBAN_RPC_URL;
  const primaryRpcUrl = (envVars.SOROBAN_RPC_URL || '').trim() || defaultRpcUrl;

  const extraRpcUrls = (envVars.SOROBAN_RPC_URLS || '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);

  const rpcUrls = [...new Set([primaryRpcUrl, ...extraRpcUrls].filter(Boolean))];

  const expectedPassphrase = SOROBAN_NETWORK_PASSPHRASES[networkId];
  const configuredPassphrase = envVars.SOROBAN_NETWORK_PASSPHRASE
    ? envVars.SOROBAN_NETWORK_PASSPHRASE.trim()
    : expectedPassphrase;

  const validation = validateSorobanNetworkPassphrase({
    network: rawNetwork,
    networkPassphrase: configuredPassphrase,
    allowMainnet,
  });

  const contracts = {
    smartWalletFactory: (envVars.SOROBAN_SMART_WALLET_FACTORY_ID || envVars.SOROBAN_FACTORY_CONTRACT_ID || '').trim() || null,
    smartWalletWasmHash: (envVars.SOROBAN_SMART_WALLET_WASM_HASH || '').trim() || null,
    escrow: (envVars.SOROBAN_ESCROW_CONTRACT_ID || '').trim() || null,
    attestation: (envVars.SOROBAN_ATTESTATION_CONTRACT_ID || '').trim() || null,
    settlement: (envVars.SOROBAN_SETTLEMENT_CONTRACT_ID || '').trim() || null,
  };

  const contractProblems = [];
  for (const [key, contractId] of Object.entries(contracts)) {
    if (key === 'smartWalletWasmHash') continue;
    if (contractId && !isContractStrkey(contractId)) {
      contractProblems.push(
        `Soroban contract ID for ${key} (${JSON.stringify(contractId)}) is not a valid 56-character C-address StrKey.`,
      );
    }
  }

  return {
    network: networkId,
    rawNetwork,
    isMainnet: networkId === 'public',
    allowMainnet,
    networkPassphrase: configuredPassphrase,
    expectedPassphrase,
    rpcUrl: primaryRpcUrl,
    rpcUrls,
    timeoutMs: Number(envVars.SOROBAN_RPC_TIMEOUT_MS || 10000),
    circuitThreshold: Number(envVars.SOROBAN_CIRCUIT_THRESHOLD || 3),
    circuitCooldownMs: Number(envVars.SOROBAN_CIRCUIT_COOLDOWN_MS || 30000),
    maxRetries: Number(envVars.SOROBAN_RPC_MAX_RETRIES || 3),
    baseBackoffMs: Number(envVars.SOROBAN_RPC_BACKOFF_MS || 200),
    maxBackoffMs: Number(envVars.SOROBAN_RPC_MAX_BACKOFF_MS || 5000),
    pollIntervalMs: Number(envVars.SOROBAN_TX_POLL_INTERVAL_MS || 1000),
    pollTimeoutMs: Number(envVars.SOROBAN_TX_POLL_TIMEOUT_MS || 30000),
    eventPollIntervalMs: Number(envVars.SOROBAN_EVENT_POLL_INTERVAL_MS || 2000),
    contracts,
    problems: [...validation.problems, ...contractProblems],
  };
};

const sorobanConfig = resolveSorobanConfig();

module.exports = {
  TESTNET_SOROBAN_RPC_URL,
  MAINNET_SOROBAN_RPC_URL,
  DEFAULT_SOROBAN_RPC_URLS,
  SOROBAN_NETWORK_PASSPHRASES,
  isContractStrkey,
  validateSorobanNetworkPassphrase,
  assertSorobanNetworkPassphrase,
  resolveSorobanConfig,
  sorobanConfig,
};
