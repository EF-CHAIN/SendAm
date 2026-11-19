'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const StellarSdk = require('@stellar/stellar-sdk');

const {
  isContractStrkey,
  validateSorobanNetworkPassphrase,
  assertSorobanNetworkPassphrase,
  resolveSorobanConfig,
  SOROBAN_NETWORK_PASSPHRASES,
} = require('../src/config/soroban');

const {
  parseCliArgs,
  compileSorobanContracts,
  optimizeContractWasm,
  deriveDeterministicContractId,
  writeContractIdsToEnv,
  deployContractToNetwork,
  runDeployPipeline,
} = require('../../../scripts/deploy-soroban');

// Minimal valid WebAssembly module: (\0asm + version 1)
const SAMPLE_WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

describe('Soroban Network Passphrase & Config Validation (#931)', () => {
  test('validates testnet and mainnet passphrases accurately', () => {
    const testnetCheck = validateSorobanNetworkPassphrase({
      network: 'testnet',
      networkPassphrase: SOROBAN_NETWORK_PASSPHRASES.testnet,
    });
    assert.equal(testnetCheck.valid, true);
    assert.equal(testnetCheck.networkId, 'testnet');
    assert.deepEqual(testnetCheck.problems, []);

    const mainnetDenied = validateSorobanNetworkPassphrase({
      network: 'mainnet',
      networkPassphrase: SOROBAN_NETWORK_PASSPHRASES.public,
      allowMainnet: false,
    });
    assert.equal(mainnetDenied.valid, false);
    assert.match(mainnetDenied.problems[0], /STELLAR_ALLOW_MAINNET=true/);

    const mainnetAllowed = validateSorobanNetworkPassphrase({
      network: 'mainnet',
      networkPassphrase: SOROBAN_NETWORK_PASSPHRASES.public,
      allowMainnet: true,
    });
    assert.equal(mainnetAllowed.valid, true);
    assert.equal(mainnetAllowed.networkId, 'public');
  });

  test('rejects mismatched network passphrases and unknown network identifiers', () => {
    const mismatch = validateSorobanNetworkPassphrase({
      network: 'testnet',
      networkPassphrase: SOROBAN_NETWORK_PASSPHRASES.public,
    });
    assert.equal(mismatch.valid, false);
    assert.match(mismatch.problems[0], /passphrase mismatch/i);

    assert.throws(
      () => assertSorobanNetworkPassphrase({ network: 'unknown-net' }),
      /Invalid Soroban network/,
    );
  });

  test('validates Soroban C-address StrKeys and flags malformed contract IDs in resolveSorobanConfig', () => {
    const { contractId } = deriveDeterministicContractId(
      SAMPLE_WASM,
      SOROBAN_NETWORK_PASSPHRASES.testnet,
    );
    assert.equal(isContractStrkey(contractId), true);
    assert.equal(isContractStrkey('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'), false);
    assert.equal(isContractStrkey('CINVALID'), false);

    const validCfg = resolveSorobanConfig({
      SOROBAN_NETWORK: 'testnet',
      SOROBAN_SMART_WALLET_FACTORY_ID: contractId,
      SOROBAN_RPC_URLS: 'https://rpc1.testnet.stellar.org, https://rpc2.testnet.stellar.org',
    });
    assert.equal(validCfg.problems.length, 0);
    assert.equal(validCfg.contracts.smartWalletFactory, contractId);
    assert.equal(validCfg.rpcUrls.length, 3);

    const invalidCfg = resolveSorobanConfig({
      SOROBAN_NETWORK: 'testnet',
      SOROBAN_ESCROW_CONTRACT_ID: 'NOT_A_C_ADDRESS',
    });
    assert.equal(invalidCfg.problems.length, 1);
    assert.match(invalidCfg.problems[0], /not a valid 56-character C-address/);
  });
});

describe('Soroban Deployment & Initialization Script (#931)', () => {
  test('parseCliArgs parses network, wasm, env, and flags', () => {
    const parsed = parseCliArgs([
      '--network',
      'mainnet',
      '--allow-mainnet',
      '--dry-run',
      '--skip-build',
      '--rpc-url=https://mainnet.sorobanrpc.com',
    ]);
    assert.equal(parsed.network, 'mainnet');
    assert.equal(parsed.allowMainnet, true);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.skipBuild, true);
    assert.equal(parsed.rpcUrl, 'https://mainnet.sorobanrpc.com');
  });

  test('compileSorobanContracts and optimizeContractWasm invoke CLI and produce .optimized.wasm', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sendam-soroban-test-'));
    const wasmPath = path.join(tmpDir, 'test_contract.wasm');
    fs.writeFileSync(wasmPath, SAMPLE_WASM);

    const calls = [];
    const mockExec = (bin, args) => {
      calls.push({ bin, args });
      if (args[0] === 'contract' && args[1] === 'optimize') {
        const outIdx = args.indexOf('--wasm-out');
        fs.writeFileSync(args[outIdx + 1], SAMPLE_WASM);
      }
    };

    compileSorobanContracts({ cwd: tmpDir, wasmPath, exec: mockExec });
    assert.equal(calls[0].bin, 'cargo');
    assert.deepEqual(calls[0].args, ['build', '--target', 'wasm32v1-none', '--release']);

    const optRes = optimizeContractWasm({ wasmPath, exec: mockExec });
    assert.equal(optRes.optimized, true);
    assert.equal(optRes.cliUsed, 'soroban');
    assert.equal(fs.existsSync(optRes.optimizedPath), true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('deployContractToNetwork validates remote RPC network passphrase and rejects mismatch', async () => {
    const mismatchedRpcClient = {
      getNetwork: async () => ({
        passphrase: SOROBAN_NETWORK_PASSPHRASES.public,
      }),
    };

    await assert.rejects(
      () => deployContractToNetwork({
        wasmBuffer: SAMPLE_WASM,
        network: 'testnet',
        rpcClient: mismatchedRpcClient,
      }),
      /Remote Soroban RPC passphrase validation failed/,
    );
  });

  test('deployContractToNetwork rejects non-WASM buffers', async () => {
    await assert.rejects(
      () => deployContractToNetwork({
        wasmBuffer: Buffer.from('not-a-wasm'),
        network: 'testnet',
        dryRun: true,
      }),
      /missing \\0asm magic header/,
    );
  });

  test('runDeployPipeline compiles, optimizes, deploys via RPC, and writes validated contract IDs to .env', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sendam-deploy-pipeline-'));
    const wasmPath = path.join(tmpDir, 'sendam_smart_wallet.wasm');
    const envPath = path.join(tmpDir, '.env');

    fs.writeFileSync(
      envPath,
      'PORT=3002\nSTELLAR_NETWORK=testnet\nSOROBAN_SMART_WALLET_FACTORY_ID=\n',
      'utf8',
    );

    const expectedContractId = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 7));

    const mockExec = (bin, args) => {
      if (bin === 'cargo') {
        fs.writeFileSync(wasmPath, SAMPLE_WASM);
      } else if (args[0] === 'contract' && args[1] === 'optimize') {
        const outIdx = args.indexOf('--wasm-out');
        fs.writeFileSync(args[outIdx + 1], SAMPLE_WASM);
      }
    };

    const mockRpcClient = {
      getNetwork: async () => ({
        passphrase: SOROBAN_NETWORK_PASSPHRASES.testnet,
        protocolVersion: 22,
      }),
    };

    const result = await runDeployPipeline({
      network: 'testnet',
      wasmPath,
      envPath,
      forceBuild: true,
      exec: mockExec,
      rpcClient: mockRpcClient,
      deployerFn: async ({ networkId, networkPassphrase }) => {
        assert.equal(networkId, 'testnet');
        assert.equal(networkPassphrase, SOROBAN_NETWORK_PASSPHRASES.testnet);
        return { contractId: expectedContractId };
      },
    });

    assert.equal(result.contractId, expectedContractId);
    assert.equal(result.optimized, true);
    assert.equal(result.network, 'testnet');

    const writtenEnv = fs.readFileSync(envPath, 'utf8');
    assert.match(writtenEnv, new RegExp(`SOROBAN_SMART_WALLET_FACTORY_ID=${expectedContractId}`));
    assert.match(writtenEnv, /SOROBAN_NETWORK=testnet/);
    assert.match(writtenEnv, /PORT=3002/);

    // Verify writeContractIdsToEnv rejects invalid contract IDs
    assert.throws(
      () => writeContractIdsToEnv({
        envPath,
        updates: { SOROBAN_SMART_WALLET_FACTORY_ID: 'INVALID_ID' },
      }),
      /Refusing to write invalid Soroban contract ID/,
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
