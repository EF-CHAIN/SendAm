'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const StellarSdk = require('@stellar/stellar-sdk');

const {
  createSorobanClient,
  computeExponentialBackoff,
  SorobanRpcOutageError,
  SorobanSimulationError,
  SorobanTransactionTimeoutError,
  SorobanTransactionFailedError,
} = require('../src/blockchain/soroban.client');

describe('Soroban RPC Client (#932)', () => {
  test('computeExponentialBackoff grows exponentially and respects maxBackoffMs cap', () => {
    assert.equal(computeExponentialBackoff(0, { baseBackoffMs: 100, maxBackoffMs: 1000 }), 100);
    assert.equal(computeExponentialBackoff(1, { baseBackoffMs: 100, maxBackoffMs: 1000 }), 200);
    assert.equal(computeExponentialBackoff(2, { baseBackoffMs: 100, maxBackoffMs: 1000 }), 400);
    assert.equal(computeExponentialBackoff(5, { baseBackoffMs: 100, maxBackoffMs: 1000 }), 1000);
  });

  test('fails over to secondary RPC endpoint on getHealth and trips circuit breaker after threshold', async () => {
    const sleepCalls = [];
    let currentTime = 1000;

    const mockServers = {
      'https://primary.rpc.test': {
        getHealth: async () => {
          const err = new Error('Primary connection timeout');
          err.code = 'ETIMEDOUT';
          throw err;
        },
      },
      'https://secondary.rpc.test': {
        getHealth: async () => ({ status: 'healthy', latestLedger: 12345 }),
      },
    };

    const client = createSorobanClient({
      rpcUrls: ['https://primary.rpc.test', 'https://secondary.rpc.test'],
      circuitThreshold: 2,
      circuitCooldownMs: 30000,
      maxRetries: 2,
      baseBackoffMs: 100,
      serverFactory: (url) => mockServers[url],
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      now: () => currentTime,
    });

    const health1 = await client.getHealth();
    assert.equal(health1.status, 'healthy');

    const health2 = await client.getHealth();
    assert.equal(health2.status, 'healthy');

    const epHealth = client.getEndpointHealth();
    assert.equal(epHealth[0].url, 'https://primary.rpc.test');
    assert.equal(epHealth[0].open, true);
    assert.equal(epHealth[0].consecutiveFailures, 2);
    assert.equal(epHealth[1].url, 'https://secondary.rpc.test');
    assert.equal(epHealth[1].open, false);
  });

  test('applies exponential backoff when all endpoints fail transiently and throws SorobanRpcOutageError when circuits open', async () => {
    const sleepCalls = [];
    const client = createSorobanClient({
      rpcUrls: ['https://rpc1.test'],
      circuitThreshold: 5,
      maxRetries: 3,
      baseBackoffMs: 50,
      maxBackoffMs: 500,
      serverFactory: () => ({
        getHealth: async () => {
          const err = new Error('503 Service Unavailable');
          err.status = 503;
          throw err;
        },
      }),
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    await assert.rejects(() => client.getHealth(), /503 Service Unavailable/);
    assert.deepEqual(sleepCalls, [50, 100, 200]);

    // Next two failures trip circuit threshold (5)
    await assert.rejects(() => client.getHealth(), SorobanRpcOutageError);
  });

  test('simulates contract calls and extracts ScVal return values', async () => {
    const contractId = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 3));
    const expectedRetVal = StellarSdk.nativeToScVal(42, { type: 'u32' });

    const client = createSorobanClient({
      rpcUrls: ['https://rpc.test'],
      serverFactory: () => ({
        simulateTransaction: async (tx) => {
          assert.ok(tx);
          return {
            id: 'sim-1',
            latestLedger: 500,
            result: {
              retval: expectedRetVal,
              auth: [],
            },
          };
        },
      }),
    });

    const { returnValue, simulation } = await client.simulateContractCall({
      contractId,
      method: 'get_wallet_count',
      args: [],
    });

    assert.equal(Number(returnValue), 42);
    assert.equal(simulation.latestLedger, 500);
  });

  test('throws SorobanSimulationError when simulateTransaction returns an on-chain simulation error', async () => {
    const contractId = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 4));
    const client = createSorobanClient({
      rpcUrls: ['https://rpc.test'],
      serverFactory: () => ({
        simulateTransaction: async () => ({
          id: 'sim-err',
          error: 'HostError: Error(Contract, #7)',
        }),
      }),
    });

    await assert.rejects(
      () => client.simulateContractCall({ contractId, method: 'execute' }),
      (err) => {
        assert.ok(err instanceof SorobanSimulationError);
        assert.match(err.message, /HostError: Error\(Contract, #7\)/);
        return true;
      },
    );
  });

  test('pollTransaction polls getTransaction with exponential backoff until SUCCESS', async () => {
    const txHash = 'a'.repeat(64);
    const statuses = ['NOT_FOUND', 'NOT_FOUND', 'SUCCESS'];
    let callCount = 0;
    const delays = [];
    let clock = 1000;

    const client = createSorobanClient({
      rpcUrls: ['https://rpc.test'],
      pollIntervalMs: 100,
      pollTimeoutMs: 5000,
      maxBackoffMs: 1000,
      serverFactory: () => ({
        getTransaction: async (hash) => {
          assert.equal(hash, txHash);
          const status = statuses[Math.min(callCount, statuses.length - 1)];
          callCount += 1;
          if (status === 'SUCCESS') {
            return {
              status: 'SUCCESS',
              ledger: 999,
              returnValue: StellarSdk.nativeToScVal('confirmed_ok'),
            };
          }
          return { status: 'NOT_FOUND' };
        },
      }),
      sleep: async (ms) => {
        delays.push(ms);
        clock += ms;
      },
      now: () => clock,
    });

    const confirmed = await client.pollTransaction(txHash);
    assert.equal(confirmed.status, 'SUCCESS');
    assert.equal(confirmed.ledger, 999);
    assert.equal(confirmed.parsedReturnValue, 'confirmed_ok');
    assert.equal(callCount, 3);
    assert.deepEqual(delays, [100, 200]);
  });

  test('pollTransaction throws SorobanTransactionFailedError on FAILED and SorobanTransactionTimeoutError on timeout', async () => {
    const txHash = 'b'.repeat(64);
    const failedClient = createSorobanClient({
      rpcUrls: ['https://rpc.test'],
      serverFactory: () => ({
        getTransaction: async () => ({ status: 'FAILED', ledger: 1001 }),
      }),
    });

    await assert.rejects(
      () => failedClient.pollTransaction(txHash),
      (err) => err instanceof SorobanTransactionFailedError && err.hash === txHash,
    );

    let clock = 0;
    const timeoutClient = createSorobanClient({
      rpcUrls: ['https://rpc.test'],
      pollIntervalMs: 100,
      pollTimeoutMs: 250,
      serverFactory: () => ({
        getTransaction: async () => ({ status: 'NOT_FOUND' }),
      }),
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });

    await assert.rejects(
      () => timeoutClient.pollTransaction(txHash),
      (err) => err instanceof SorobanTransactionTimeoutError && err.hash === txHash,
    );
  });
});
