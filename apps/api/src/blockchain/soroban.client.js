'use strict';

// Resilient Soroban RPC Client (#932).
//
// Wraps `StellarSdk.rpc.Server` with multi-endpoint failover, circuit-breaking,
// exponential backoff with jitter on `getHealth` and `getTransaction`,
// transaction simulation (`simulateTransaction`), and confirmation polling
// (`pollTransaction`, `submitAndConfirmTransaction`).

const { StellarSdk } = require('../config/stellar');
const { sorobanConfig } = require('../config/soroban');
const logger = require('../utils/logger');

class SorobanRpcError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SorobanRpcError';
    Object.assign(this, details);
  }
}

class SorobanRpcOutageError extends SorobanRpcError {
  constructor(message = 'All Soroban RPC endpoints are unavailable.') {
    super(message);
    this.name = 'SorobanRpcOutageError';
    this.isSorobanOutage = true;
  }
}

class SorobanSimulationError extends SorobanRpcError {
  constructor(message, simulationResponse = null) {
    super(message);
    this.name = 'SorobanSimulationError';
    this.isSimulationError = true;
    this.simulationResponse = simulationResponse;
  }
}

class SorobanTransactionTimeoutError extends SorobanRpcError {
  constructor(hash, lastResponse = null) {
    super(`Timed out waiting for Soroban transaction ${hash} confirmation.`);
    this.name = 'SorobanTransactionTimeoutError';
    this.isTimeout = true;
    this.hash = hash;
    this.lastResponse = lastResponse;
  }
}

class SorobanTransactionFailedError extends SorobanRpcError {
  constructor(hash, response = null) {
    super(`Soroban transaction ${hash} failed on-chain.`);
    this.name = 'SorobanTransactionFailedError';
    this.isTransactionFailed = true;
    this.hash = hash;
    this.response = response;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Compute exponential backoff delay in milliseconds:
 * `min(maxBackoffMs, baseBackoffMs * 2^attempt)`.
 *
 * @param {number} attempt - Zero-based retry attempt index.
 * @param {object} [options]
 * @param {number} [options.baseBackoffMs=200]
 * @param {number} [options.maxBackoffMs=5000]
 * @param {number} [options.jitterRatio=0]
 * @param {function} [options.random=Math.random]
 * @returns {number} Delay in milliseconds.
 */
const computeExponentialBackoff = (
  attempt,
  {
    baseBackoffMs = 200,
    maxBackoffMs = 5000,
    jitterRatio = 0,
    random = Math.random,
  } = {},
) => {
  const safeAttempt = Math.max(0, Number(attempt) || 0);
  const expDelay = Math.min(maxBackoffMs, baseBackoffMs * (2 ** safeAttempt));
  if (!jitterRatio || jitterRatio <= 0) {
    return expDelay;
  }
  const jitter = expDelay * jitterRatio * random();
  return Math.min(maxBackoffMs, Math.round(expDelay + jitter));
};

const isTransientError = (err) => {
  if (!err) return false;
  if (err.isSimulationError || err.isTransactionFailed) return false;
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.code === 'ENOTFOUND') {
    return true;
  }
  const status = err.response?.status || err.status;
  if (status && (status === 429 || status >= 500)) {
    return true;
  }
  // Network/RPC errors without definitive 4xx status are treated as transient for failover
  return !status || status >= 500;
};

/**
 * Create a resilient Soroban RPC client with endpoint failover, circuit breaking,
 * and exponential backoff on `getHealth` and `getTransaction`.
 *
 * @param {object} [options]
 * @param {string[]} [options.rpcUrls] - Ordered list of Soroban RPC URLs.
 * @param {string} [options.networkPassphrase] - Stellar network passphrase.
 * @param {number} [options.circuitThreshold=3] - Consecutive failures before tripping endpoint circuit.
 * @param {number} [options.circuitCooldownMs=30000] - Circuit open duration in ms.
 * @param {number} [options.maxRetries=3] - Max exponential backoff retries for getHealth / getTransaction.
 * @param {number} [options.baseBackoffMs=200] - Base backoff in ms.
 * @param {number} [options.maxBackoffMs=5000] - Max backoff cap in ms.
 * @param {number} [options.pollIntervalMs=1000] - Initial transaction status poll interval in ms.
 * @param {number} [options.pollTimeoutMs=30000] - Total transaction confirmation poll timeout in ms.
 * @param {function} [options.serverFactory] - Factory `(url, opts) => rpc.Server` (injectable for unit tests).
 * @param {function} [options.sleep] - Async sleep `(ms) => Promise<void>` (injectable for unit tests).
 * @param {function} [options.now] - Clock `() => number` (injectable for unit tests).
 */
const createSorobanClient = ({
  rpcUrls = sorobanConfig.rpcUrls,
  networkPassphrase = sorobanConfig.networkPassphrase,
  circuitThreshold = sorobanConfig.circuitThreshold,
  circuitCooldownMs = sorobanConfig.circuitCooldownMs,
  maxRetries = sorobanConfig.maxRetries,
  baseBackoffMs = sorobanConfig.baseBackoffMs,
  maxBackoffMs = sorobanConfig.maxBackoffMs,
  pollIntervalMs = sorobanConfig.pollIntervalMs,
  pollTimeoutMs = sorobanConfig.pollTimeoutMs,
  serverFactory = (url, opts) => new StellarSdk.rpc.Server(url, opts),
  sleep = defaultSleep,
  now = Date.now,
} = {}) => {
  const urls = Array.isArray(rpcUrls) && rpcUrls.length > 0
    ? [...new Set(rpcUrls.filter(Boolean))]
    : [sorobanConfig.rpcUrl];

  const endpoints = urls.map((url, index) => ({
    url,
    index,
    server: serverFactory(url, { allowHttp: url.startsWith('http://') }),
    consecutiveFailures: 0,
    open: false,
    openedAt: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
  }));

  const isEndpointOpen = (ep) => ep.open && (now() - ep.openedAt) < circuitCooldownMs;

  const getAvailableEndpoints = () => endpoints.filter((ep) => !isEndpointOpen(ep));

  const recordSuccess = (ep) => {
    if (!ep) return;
    ep.consecutiveFailures = 0;
    ep.open = false;
    ep.lastSuccessAt = now();
  };

  const recordFailure = (ep) => {
    if (!ep) return;
    ep.consecutiveFailures += 1;
    ep.lastFailureAt = now();
    if (ep.consecutiveFailures >= circuitThreshold) {
      ep.open = true;
      ep.openedAt = now();
    }
  };

  /**
   * Execute an RPC read operation across available endpoints with automatic failover
   * and optional exponential backoff retries.
   *
   * @param {function} operation - `(server, endpoint) => Promise<any>`
   * @param {object} [execOpts]
   * @param {number} [execOpts.retries=0] - Number of backoff retry rounds across endpoints.
   * @param {boolean} [execOpts.allowFailover=true] - Whether to fail over across secondary endpoints.
   */
  const executeWithFailover = async (
    operation,
    {
      retries = 0,
      allowFailover = true,
    } = {},
  ) => {
    let lastError = null;
    const totalAttempts = Math.max(1, Number(retries) + 1);

    for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
      const available = getAvailableEndpoints();
      if (available.length === 0) {
        throw new SorobanRpcOutageError('All Soroban RPC endpoints are unavailable (circuit open).');
      }

      const candidates = allowFailover ? available : [available[0]];

      for (const ep of candidates) {
        try {
          const result = await operation(ep.server, ep);
          recordSuccess(ep);
          return result;
        } catch (err) {
          lastError = err;
          if (!isTransientError(err)) {
            throw err;
          }
          recordFailure(ep);
          logger.warn('soroban_rpc_endpoint_failure', {
            endpoint: ep.url,
            attempt: attempt + 1,
            consecutiveFailures: ep.consecutiveFailures,
            circuitOpen: ep.open,
            error: err.message,
          });
        }
      }

      if (attempt < totalAttempts - 1) {
        const delayMs = computeExponentialBackoff(attempt, { baseBackoffMs, maxBackoffMs });
        await sleep(delayMs);
      }
    }

    if (getAvailableEndpoints().length === 0) {
      throw new SorobanRpcOutageError(
        lastError
          ? `All Soroban RPC endpoints failed (circuit open): ${lastError.message}`
          : 'All Soroban RPC endpoints are unavailable (circuit open).',
      );
    }

    throw lastError || new SorobanRpcOutageError();
  };

  /**
   * Query Soroban RPC node health with exponential backoff and endpoint failover.
   */
  const getHealth = async () => executeWithFailover(
    async (server) => {
      const health = await server.getHealth();
      if (health && health.status && health.status !== 'healthy') {
        const unhealthyErr = new SorobanRpcError(`Soroban RPC reported unhealthy status: ${health.status}`);
        unhealthyErr.status = 503;
        throw unhealthyErr;
      }
      return health;
    },
    { retries: maxRetries, allowFailover: true },
  );

  /**
   * Fetch Soroban network details (`passphrase`, `protocolVersion`, `friendbotUrl`).
   */
  const getNetwork = async () => executeWithFailover(
    (server) => server.getNetwork(),
    { retries: maxRetries, allowFailover: true },
  );

  /**
   * Fetch the latest ledger sequence and metadata from Soroban RPC.
   */
  const getLatestLedger = async () => executeWithFailover(
    (server) => server.getLatestLedger(),
    { retries: maxRetries, allowFailover: true },
  );

  /**
   * Fetch a single transaction status/result by hash with exponential backoff and failover.
   *
   * @param {string} hash - Transaction hash.
   */
  const getTransaction = async (hash) => {
    if (!hash || typeof hash !== 'string') {
      throw new SorobanRpcError('Transaction hash is required for getTransaction.');
    }
    return executeWithFailover(
      (server) => server.getTransaction(hash),
      { retries: maxRetries, allowFailover: true },
    );
  };

  /**
   * Simulate a transaction or contract invocation via Soroban RPC.
   * Validates the simulation result and throws `SorobanSimulationError` if the
   * RPC simulation reports an on-chain error.
   *
   * @param {object} transaction - Built Stellar transaction envelope.
   * @param {object} [addlResources] - Optional simulation resource config.
   */
  const simulateTransaction = async (transaction, addlResources) => {
    if (!transaction) {
      throw new SorobanRpcError('Transaction is required for simulateTransaction.');
    }

    const simulation = await executeWithFailover(
      (server) => server.simulateTransaction(transaction, addlResources),
      { retries: maxRetries, allowFailover: true },
    );

    const isError = StellarSdk.rpc?.Api?.isSimulationError
      ? StellarSdk.rpc.Api.isSimulationError(simulation)
      : Boolean(simulation && simulation.error);

    if (isError) {
      throw new SorobanSimulationError(
        `Soroban transaction simulation failed: ${simulation.error}`,
        simulation,
      );
    }

    return simulation;
  };

  /**
   * Simulate a specific contract function call by building an invocation transaction
   * and running `simulateTransaction`.
   *
   * @param {object} params
   * @param {string} params.contractId - Soroban C-address of the contract.
   * @param {string} params.method - Contract function name.
   * @param {StellarSdk.xdr.ScVal[]} [params.args=[]] - ScVal arguments array.
   * @param {string} [params.sourceAccount] - Optional source account G-address.
   * @param {string} [params.fee='100'] - Base fee in stroops.
   */
  const simulateContractCall = async ({
    contractId,
    method,
    args = [],
    sourceAccount,
    fee = StellarSdk.BASE_FEE || '100',
  }) => {
    if (!contractId || !method) {
      throw new SorobanRpcError('contractId and method are required to simulate a contract call.');
    }

    const contract = new StellarSdk.Contract(contractId);
    const operation = contract.call(method, ...args);

    const account = sourceAccount
      ? await executeWithFailover((server) => server.getAccount(sourceAccount), { retries: 1 })
      : new StellarSdk.Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0');

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: String(fee),
      networkPassphrase: networkPassphrase || StellarSdk.Networks.TESTNET,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simulation = await simulateTransaction(tx);
    let returnValue = null;
    if (simulation?.result?.retval) {
      try {
        returnValue = StellarSdk.scValToNative(simulation.result.retval);
      } catch (_err) {
        returnValue = simulation.result.retval;
      }
    }

    return {
      simulation,
      returnValue,
      transaction: tx,
    };
  };

  /**
   * Send a signed transaction to the primary healthy Soroban RPC endpoint.
   * Writes do not automatically duplicate across failover endpoints to prevent double-submission,
   * unless the initial call suffered a pre-submission transport failure and the caller explicitly
   * enables retry.
   *
   * @param {object} transaction - Signed Stellar Transaction or FeeBumpTransaction.
   */
  const sendTransaction = async (transaction) => {
    if (!transaction) {
      throw new SorobanRpcError('Signed transaction is required for sendTransaction.');
    }
    return executeWithFailover(
      (server) => server.sendTransaction(transaction),
      { retries: 0, allowFailover: false },
    );
  };

  /**
   * Poll `getTransaction(hash)` with exponential backoff until the transaction
   * reaches `SUCCESS` or `FAILED`, or `pollTimeoutMs` expires.
   *
   * @param {string} hash - Transaction hash to poll.
   * @param {object} [pollOpts]
   * @param {number} [pollOpts.intervalMs=pollIntervalMs] - Base polling interval in ms.
   * @param {number} [pollOpts.timeoutMs=pollTimeoutMs] - Maximum total wait time in ms.
   * @param {number} [pollOpts.maxIntervalMs=maxBackoffMs] - Maximum backoff interval between polls.
   */
  const pollTransaction = async (
    hash,
    {
      intervalMs = pollIntervalMs,
      timeoutMs = pollTimeoutMs,
      maxIntervalMs = maxBackoffMs,
    } = {},
  ) => {
    if (!hash || typeof hash !== 'string') {
      throw new SorobanRpcError('Transaction hash is required for pollTransaction.');
    }

    const Status = StellarSdk.rpc?.Api?.GetTransactionStatus || {
      SUCCESS: 'SUCCESS',
      NOT_FOUND: 'NOT_FOUND',
      FAILED: 'FAILED',
    };

    const startTime = now();
    let pollAttempt = 0;
    let lastResponse = null;

    while (true) {
      lastResponse = await getTransaction(hash);

      if (lastResponse?.status === Status.SUCCESS) {
        let returnValue = null;
        if (lastResponse.returnValue) {
          try {
            returnValue = StellarSdk.scValToNative(lastResponse.returnValue);
          } catch (_err) {
            returnValue = lastResponse.returnValue;
          }
        }
        return {
          ...lastResponse,
          parsedReturnValue: returnValue,
        };
      }

      if (lastResponse?.status === Status.FAILED) {
        throw new SorobanTransactionFailedError(hash, lastResponse);
      }

      const elapsed = now() - startTime;
      if (elapsed >= timeoutMs) {
        throw new SorobanTransactionTimeoutError(hash, lastResponse);
      }

      const waitMs = computeExponentialBackoff(pollAttempt, {
        baseBackoffMs: intervalMs,
        maxBackoffMs: maxIntervalMs,
      });
      pollAttempt += 1;
      await sleep(Math.min(waitMs, Math.max(1, timeoutMs - elapsed)));
    }
  };

  /**
   * Query Soroban contract events via `getEvents` with endpoint failover.
   *
   * @param {object} request - `{ startLedger, filters, pagination }`
   */
  const getEvents = async (request) => executeWithFailover(
    (server) => server.getEvents(request),
    { retries: maxRetries, allowFailover: true },
  );

  /**
   * Return circuit breaker health snapshots for all configured Soroban RPC endpoints.
   */
  const getEndpointHealth = () => endpoints.map((ep) => ({
    url: ep.url,
    index: ep.index,
    open: isEndpointOpen(ep),
    consecutiveFailures: ep.consecutiveFailures,
    lastSuccessAt: ep.lastSuccessAt,
    lastFailureAt: ep.lastFailureAt,
  }));

  return {
    getHealth,
    getNetwork,
    getLatestLedger,
    getTransaction,
    simulateTransaction,
    simulateContractCall,
    sendTransaction,
    pollTransaction,
    getEvents,
    getEndpointHealth,
    executeWithFailover,
    _endpoints: endpoints,
  };
};

const defaultSorobanClient = createSorobanClient();

module.exports = {
  createSorobanClient,
  defaultSorobanClient,
  computeExponentialBackoff,
  SorobanRpcError,
  SorobanRpcOutageError,
  SorobanSimulationError,
  SorobanTransactionTimeoutError,
  SorobanTransactionFailedError,
};
