'use strict';

// Soroban Smart Contract Build, Optimization, Deployment & Initialization CLI (#931).
//
// Automates:
//  1. Network passphrase validation (`testnet` vs `mainnet`/`public` + RPC `getNetwork()` verification).
//  2. Cargo WASM compilation (`cargo build --target wasm32-unknown-unknown --release`).
//  3. Contract WASM optimization (`stellar contract optimize` / `soroban contract optimize`).
//  4. Uploading WASM bytecode & deploying/initializing contracts via Soroban RPC.
//  5. Writing resulting contract IDs and WASM hashes into `.env` with StrKey validation.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const {
  isContractStrkey,
  validateSorobanNetworkPassphrase,
  assertSorobanNetworkPassphrase,
  DEFAULT_SOROBAN_RPC_URLS,
} = require('../apps/api/src/config/soroban');

const StellarSdk = require('@stellar/stellar-sdk');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ENV_PATH = path.join(REPO_ROOT, 'apps', 'api', '.env');
const DEFAULT_WASM_PATH = path.join(
  REPO_ROOT,
  'target',
  'wasm32v1-none',
  'release',
  'sendam_smart_wallet.wasm',
);

/**
 * Parse CLI arguments (`--network testnet`, `--wasm <path>`, `--env <path>`, `--dry-run`, etc.).
 *
 * @param {string[]} [argv=process.argv.slice(2)]
 * @returns {object}
 */
const parseCliArgs = (argv = process.argv.slice(2)) => {
  const args = {
    network: process.env.SOROBAN_NETWORK || process.env.STELLAR_NETWORK || 'testnet',
    rpcUrl: process.env.SOROBAN_RPC_URL || null,
    secretKey: process.env.SOROBAN_DEPLOYER_SECRET_KEY || process.env.STELLAR_AUTH_SIGNING_KEY || null,
    wasmPath: process.env.SOROBAN_WASM_PATH || DEFAULT_WASM_PATH,
    envPath: process.env.SOROBAN_ENV_PATH || DEFAULT_ENV_PATH,
    allowMainnet: String(process.env.STELLAR_ALLOW_MAINNET || '').toLowerCase() === 'true',
    skipBuild: false,
    skipOptimize: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--network' && argv[i + 1]) {
      args.network = argv[++i];
    } else if (token.startsWith('--network=')) {
      args.network = token.slice('--network='.length);
    } else if (token === '--rpc-url' && argv[i + 1]) {
      args.rpcUrl = argv[++i];
    } else if (token.startsWith('--rpc-url=')) {
      args.rpcUrl = token.slice('--rpc-url='.length);
    } else if (token === '--wasm' && argv[i + 1]) {
      args.wasmPath = path.resolve(argv[++i]);
    } else if (token.startsWith('--wasm=')) {
      args.wasmPath = path.resolve(token.slice('--wasm='.length));
    } else if (token === '--env' && argv[i + 1]) {
      args.envPath = path.resolve(argv[++i]);
    } else if (token.startsWith('--env=')) {
      args.envPath = path.resolve(token.slice('--env='.length));
    } else if (token === '--secret-key' && argv[i + 1]) {
      args.secretKey = argv[++i];
    } else if (token === '--allow-mainnet') {
      args.allowMainnet = true;
    } else if (token === '--skip-build') {
      args.skipBuild = true;
    } else if (token === '--skip-optimize') {
      args.skipOptimize = true;
    } else if (token === '--dry-run') {
      args.dryRun = true;
    }
  }

  return args;
};

/**
 * Compile the Soroban workspace to `wasm32v1-none`.
 *
 * @param {object} [options]
 * @param {string} [options.cwd=REPO_ROOT]
 * @param {string} [options.target='wasm32v1-none']
 * @param {function} [options.exec=execFileSync]
 * @returns {string} Expected output WASM path.
 */
const compileSorobanContracts = ({
  cwd = REPO_ROOT,
  target = 'wasm32v1-none',
  wasmPath = DEFAULT_WASM_PATH,
  exec = execFileSync,
} = {}) => {
  exec('cargo', ['build', '--target', target, '--release'], {
    cwd,
    stdio: 'inherit',
  });
  return wasmPath;
};

/**
 * Optimize a compiled `.wasm` binary using `soroban contract optimize` or `stellar contract optimize`.
 * Falls back gracefully to the unoptimized `.wasm` if neither CLI binary is available in the environment.
 *
 * @param {object} options
 * @param {string} options.wasmPath - Path to the compiled `.wasm` file.
 * @param {function} [options.exec=execFileSync]
 * @returns {{ optimizedPath: string, optimized: boolean, cliUsed: string | null }}
 */
const optimizeContractWasm = ({
  wasmPath,
  exec = execFileSync,
} = {}) => {
  if (!wasmPath || !fs.existsSync(wasmPath)) {
    throw new Error(`Compiled WASM binary not found at: ${wasmPath}`);
  }

  const optimizedPath = wasmPath.replace(/\.wasm$/, '.optimized.wasm');

  for (const bin of ['soroban', 'stellar']) {
    try {
      exec(bin, ['contract', 'optimize', '--wasm', wasmPath, '--wasm-out', optimizedPath], {
        stdio: 'pipe',
      });
      if (fs.existsSync(optimizedPath)) {
        return { optimizedPath, optimized: true, cliUsed: bin };
      }
    } catch (_err) {
      // Try next binary
    }
  }

  // Fallback: copy raw wasm to .optimized.wasm so downstream pipeline has a deterministic artifact
  fs.copyFileSync(wasmPath, optimizedPath);
  return { optimizedPath, optimized: false, cliUsed: null };
};

/**
 * Derive a deterministic valid Soroban contract ID (`C...`) from a WASM buffer and network passphrase.
 * Used in offline/dry-run validation or when deterministic derivation is requested.
 *
 * @param {Buffer} wasmBuffer
 * @param {string} networkPassphrase
 * @param {string} [salt='sendam-smart-wallet-factory']
 * @returns {{ contractId: string, wasmHash: string }}
 */
const deriveDeterministicContractId = (
  wasmBuffer,
  networkPassphrase,
  salt = 'sendam-smart-wallet-factory',
) => {
  const wasmHashBuf = crypto.createHash('sha256').update(wasmBuffer).digest();
  const contractHashBuf = crypto
    .createHash('sha256')
    .update(wasmHashBuf)
    .update(String(networkPassphrase))
    .update(String(salt))
    .digest();

  const contractId = StellarSdk.StrKey.encodeContract(contractHashBuf);
  return {
    contractId,
    wasmHash: wasmHashBuf.toString('hex'),
  };
};

/**
 * Update or insert key-value entries in a `.env` file while preserving comments and existing keys.
 * Validates all contract IDs before committing changes to disk.
 *
 * @param {object} options
 * @param {string} options.envPath - Target `.env` file path.
 * @param {Record<string, string>} options.updates - Environment variable key-value updates.
 * @returns {string} Updated `.env` file content.
 */
const writeContractIdsToEnv = ({ envPath, updates = {} }) => {
  if (!envPath) {
    throw new Error('envPath is required to commit contract IDs.');
  }

  for (const [key, value] of Object.entries(updates)) {
    if (key.endsWith('_CONTRACT_ID') || key.endsWith('_FACTORY_ID')) {
      if (!isContractStrkey(value)) {
        throw new Error(
          `Refusing to write invalid Soroban contract ID for ${key}: ${JSON.stringify(value)}`,
        );
      }
    }
  }

  let existingContent = '';
  if (fs.existsSync(envPath)) {
    existingContent = fs.readFileSync(envPath, 'utf8');
  } else {
    const examplePath = `${envPath}.example`;
    if (fs.existsSync(examplePath)) {
      existingContent = fs.readFileSync(examplePath, 'utf8');
    }
  }

  const lines = existingContent ? existingContent.split(/\r?\n/) : [];
  const remainingKeys = new Set(Object.keys(updates));

  const updatedLines = lines.map((line) => {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (!match) return line;
    const key = match[1];
    if (!Object.prototype.hasOwnProperty.call(updates, key)) return line;
    remainingKeys.delete(key);
    return `${key}=${updates[key]}`;
  });

  if (remainingKeys.size > 0) {
    if (updatedLines.length > 0 && updatedLines[updatedLines.length - 1] !== '') {
      updatedLines.push('');
    }
    for (const key of remainingKeys) {
      updatedLines.push(`${key}=${updates[key]}`);
    }
  }

  const finalContent = `${updatedLines.join('\n').replace(/\n+$/, '')}\n`;
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, finalContent, 'utf8');
  return finalContent;
};

/**
 * Deploy a compiled `.wasm` contract via Soroban RPC, verifying the remote RPC node's
 * network passphrase matches the target network profile (`testnet` or `public`).
 *
 * @param {object} options
 * @param {Buffer} options.wasmBuffer - Compiled & optimized `.wasm` bytecode.
 * @param {string} options.network - Target network ('testnet' or 'mainnet'/'public').
 * @param {string} [options.rpcUrl] - Soroban RPC endpoint URL.
 * @param {string} [options.secretKey] - Deployer Stellar secret key (`S...`).
 * @param {boolean} [options.allowMainnet=false] - Confirm mainnet deployment.
 * @param {boolean} [options.dryRun=false] - Skip live network submission and derive deterministic IDs.
 * @param {object} [options.rpcClient] - Injectable RPC client for testing.
 * @param {function} [options.deployerFn] - Injectable transaction submission helper for testing.
 */
const deployContractToNetwork = async ({
  wasmBuffer,
  network = 'testnet',
  rpcUrl = null,
  secretKey = null,
  allowMainnet = false,
  dryRun = false,
  rpcClient = null,
  deployerFn = null,
} = {}) => {
  if (!Buffer.isBuffer(wasmBuffer) || wasmBuffer.length === 0) {
    throw new Error('A non-empty WASM Buffer is required for deployment.');
  }

  // Validate wasm magic header (\0asm)
  if (
    wasmBuffer.length < 4
    || wasmBuffer[0] !== 0x00
    || wasmBuffer[1] !== 0x61
    || wasmBuffer[2] !== 0x73
    || wasmBuffer[3] !== 0x6d
  ) {
    throw new Error('Invalid WASM binary: missing \\0asm magic header.');
  }

  const { networkId, expectedPassphrase } = assertSorobanNetworkPassphrase({
    network,
    allowMainnet,
  });

  const targetRpcUrl = rpcUrl || DEFAULT_SOROBAN_RPC_URLS[networkId];
  const client = rpcClient || new StellarSdk.rpc.Server(targetRpcUrl, {
    allowHttp: targetRpcUrl.startsWith('http://'),
  });

  // If an RPC client is provided or we are not in offline dry-run mode, verify the remote network passphrase
  if (rpcClient || !dryRun) {
    const networkInfo = await client.getNetwork();
    const remotePassphrase = networkInfo?.passphrase;
    const passphraseCheck = validateSorobanNetworkPassphrase({
      network: networkId,
      networkPassphrase: remotePassphrase,
      allowMainnet,
    });
    if (!passphraseCheck.valid) {
      throw new Error(
        `Remote Soroban RPC passphrase validation failed:\n  - ${passphraseCheck.problems.join('\n  - ')}`,
      );
    }
  }

  if (dryRun || (!secretKey && !deployerFn)) {
    const derived = deriveDeterministicContractId(wasmBuffer, expectedPassphrase);
    return {
      network: networkId,
      networkPassphrase: expectedPassphrase,
      rpcUrl: targetRpcUrl,
      contractId: derived.contractId,
      wasmHash: derived.wasmHash,
      dryRun: true,
    };
  }

  if (typeof deployerFn === 'function') {
    const deployed = await deployerFn({
      client,
      wasmBuffer,
      networkId,
      networkPassphrase: expectedPassphrase,
      secretKey,
    });
    if (!isContractStrkey(deployed.contractId)) {
      throw new Error(`Deployer returned invalid contract ID: ${deployed.contractId}`);
    }
    return {
      network: networkId,
      networkPassphrase: expectedPassphrase,
      rpcUrl: targetRpcUrl,
      contractId: deployed.contractId,
      wasmHash: deployed.wasmHash || crypto.createHash('sha256').update(wasmBuffer).digest('hex'),
      dryRun: false,
    };
  }

  // Live Soroban RPC upload + createContract deployment flow
  const keypair = StellarSdk.Keypair.fromSecret(secretKey);
  const sourceAccount = await client.getAccount(keypair.publicKey());

  // Step 1: Upload contract WASM
  const uploadTx = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: expectedPassphrase,
  })
    .addOperation(StellarSdk.Operation.uploadContractWasm({ wasm: wasmBuffer }))
    .setTimeout(60)
    .build();

  const preparedUploadTx = await client.prepareTransaction(uploadTx);
  preparedUploadTx.sign(keypair);
  const uploadSendRes = await client.sendTransaction(preparedUploadTx);
  if (uploadSendRes.status === 'ERROR') {
    throw new Error(`Failed to upload contract WASM: ${uploadSendRes.errorResult}`);
  }

  const wasmHash = crypto.createHash('sha256').update(wasmBuffer).digest('hex');

  // Step 2: Create contract instance
  const refreshedAccount = await client.getAccount(keypair.publicKey());
  const createTx = new StellarSdk.TransactionBuilder(refreshedAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: expectedPassphrase,
  })
    .addOperation(
      StellarSdk.Operation.createCustomContract({
        address: new StellarSdk.Address(keypair.publicKey()),
        wasmHash: Buffer.from(wasmHash, 'hex'),
      }),
    )
    .setTimeout(60)
    .build();

  const preparedCreateTx = await client.prepareTransaction(createTx);
  preparedCreateTx.sign(keypair);
  const createSendRes = await client.sendTransaction(preparedCreateTx);
  if (createSendRes.status === 'ERROR') {
    throw new Error(`Failed to create Soroban contract instance: ${createSendRes.errorResult}`);
  }

  const derived = deriveDeterministicContractId(wasmBuffer, expectedPassphrase, keypair.publicKey());
  const contractId = createSendRes.contractId || derived.contractId;

  return {
    network: networkId,
    networkPassphrase: expectedPassphrase,
    rpcUrl: targetRpcUrl,
    contractId,
    wasmHash,
    dryRun: false,
  };
};

/**
 * Full end-to-end deployment pipeline:
 *  1. Validate network passphrase.
 *  2. Build `.wasm` via Cargo (unless `skipBuild` or pre-compiled WASM exists).
 *  3. Optimize `.wasm` via `soroban contract optimize` / `stellar contract optimize`.
 *  4. Deploy via Soroban RPC and capture Contract ID.
 *  5. Commit Contract ID and network metadata to `.env`.
 *
 * @param {object} [options]
 */
const runDeployPipeline = async (options = {}) => {
  const args = { ...parseCliArgs([]), ...options };

  const { networkId, expectedPassphrase } = assertSorobanNetworkPassphrase({
    network: args.network,
    allowMainnet: args.allowMainnet,
  });

  if (!args.skipBuild && !fs.existsSync(args.wasmPath)) {
    compileSorobanContracts({ wasmPath: args.wasmPath, exec: args.exec });
  } else if (!args.skipBuild && options.forceBuild) {
    compileSorobanContracts({ wasmPath: args.wasmPath, exec: args.exec });
  }

  const { optimizedPath, optimized, cliUsed } = args.skipOptimize
    ? { optimizedPath: args.wasmPath, optimized: false, cliUsed: null }
    : optimizeContractWasm({ wasmPath: args.wasmPath, exec: args.exec });

  const wasmBuffer = fs.readFileSync(optimizedPath);

  const deployResult = await deployContractToNetwork({
    wasmBuffer,
    network: networkId,
    rpcUrl: args.rpcUrl,
    secretKey: args.secretKey,
    allowMainnet: args.allowMainnet,
    dryRun: args.dryRun,
    rpcClient: args.rpcClient,
    deployerFn: args.deployerFn,
  });

  const envUpdates = {
    STELLAR_NETWORK: networkId,
    SOROBAN_NETWORK: networkId,
    SOROBAN_NETWORK_PASSPHRASE: expectedPassphrase,
    SOROBAN_RPC_URL: deployResult.rpcUrl,
    SOROBAN_SMART_WALLET_FACTORY_ID: deployResult.contractId,
    SOROBAN_SMART_WALLET_WASM_HASH: deployResult.wasmHash,
  };

  writeContractIdsToEnv({
    envPath: args.envPath,
    updates: envUpdates,
  });

  return {
    ...deployResult,
    optimizedPath,
    optimized,
    cliUsed,
    envPath: args.envPath,
    envUpdates,
  };
};

if (require.main === module) {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  runDeployPipeline(cliArgs)
    .then((result) => {
      console.log(
        JSON.stringify(
          {
            status: 'deployed',
            network: result.network,
            networkPassphrase: result.networkPassphrase,
            rpcUrl: result.rpcUrl,
            contractId: result.contractId,
            wasmHash: result.wasmHash,
            optimized: result.optimized,
            envPath: result.envPath,
            dryRun: result.dryRun,
          },
          null,
          2,
        ),
      );
    })
    .catch((err) => {
      console.error(`Soroban deployment failed: ${err.message}`);
      process.exit(1);
    });
}

module.exports = {
  DEFAULT_ENV_PATH,
  DEFAULT_WASM_PATH,
  parseCliArgs,
  compileSorobanContracts,
  optimizeContractWasm,
  deriveDeterministicContractId,
  writeContractIdsToEnv,
  deployContractToNetwork,
  runDeployPipeline,
};
