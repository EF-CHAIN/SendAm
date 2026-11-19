const StellarSdk = require('@stellar/stellar-sdk');
const config = require('../config/env');
const logger = require('../utils/logger');

const DEFAULT_SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
const DEFAULT_BASE_FEE_STROOPS = 100n;
const DEFAULT_MAX_FEE_STROOPS = 10_000_000n; // 1 XLM safety cap
const DEFAULT_RESOURCE_FEE_BUFFER_STROOPS = 0n;
const DEFAULT_RESOURCE_FEE_MULTIPLIER = 1.0;

class SorobanSimulationError extends Error {
  constructor(message, {
    simulationError,
    events = [],
    latestLedger = null,
    rawResponse = null,
    cause,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SorobanSimulationError';
    this.code = 'SOROBAN_SIMULATION_REVERTED';
    this.isSorobanSimulationError = true;
    this.simulationError = simulationError || message;
    this.events = events;
    this.latestLedger = latestLedger;
    this.rawResponse = rawResponse;
  }
}

class SorobanRestoreRequiredError extends Error {
  constructor(message, { restorePreamble, latestLedger = null, rawResponse = null } = {}) {
    super(message);
    this.name = 'SorobanRestoreRequiredError';
    this.code = 'SOROBAN_RESTORE_REQUIRED';
    this.isSorobanRestoreRequired = true;
    this.restorePreamble = restorePreamble || null;
    this.latestLedger = latestLedger;
    this.rawResponse = rawResponse;
  }
}

class SorobanFeeLimitError extends Error {
  constructor(message, { requiredFeeStroops, maxFeeStroops } = {}) {
    super(message);
    this.name = 'SorobanFeeLimitError';
    this.code = 'SOROBAN_FEE_LIMIT_EXCEEDED';
    this.isSorobanFeeLimitError = true;
    this.requiredFeeStroops = requiredFeeStroops;
    this.maxFeeStroops = maxFeeStroops;
  }
}

const getDefaultNetworkPassphrase = () => (
  config.stellar?.networkPassphrase
  || (config.stellar?.network === 'mainnet' || config.stellar?.network === 'public'
    ? StellarSdk.Networks.PUBLIC
    : StellarSdk.Networks.TESTNET)
);

const getDefaultRpcUrl = () => (
  process.env.SOROBAN_RPC_URL
  || config.stellar?.sorobanRpcUrl
  || DEFAULT_SOROBAN_RPC_URL
);

const toBigIntStroops = (value, fallback = 0n) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'bigint') return value;
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Invalid stroop amount: ${value}`);
  }
  return BigInt(normalized);
};

/**
 * Formats a clear diagnostic message from a failed Soroban simulation response.
 */
const formatSimulationRevertMessage = (simResponse) => {
  const rawErr = typeof simResponse?.error === 'string'
    ? simResponse.error.trim()
    : 'Unknown Soroban contract simulation error';

  // Extract HostError / Contract error code if present for clearer troubleshooting.
  const contractCodeMatch = rawErr.match(/Error\(Contract,\s*#(\d+)\)/i);
  if (contractCodeMatch) {
    return `Soroban simulation reverted with contract error #${contractCodeMatch[1]}: ${rawErr}`;
  }

  const hostMatch = rawErr.match(/HostError:\s*(.+)/i);
  if (hostMatch) {
    return `Soroban simulation reverted (${hostMatch[1].trim()})`;
  }

  return `Soroban simulation reverted: ${rawErr}`;
};

/**
 * Resolves a SorobanTransactionData XDR object from a simulation response's
 * `transactionData` field (SorobanDataBuilder, xdr.SorobanTransactionData, or base64 XDR).
 */
const resolveSorobanTransactionData = (transactionData) => {
  if (!transactionData) return null;

  if (typeof transactionData === 'string') {
    return StellarSdk.xdr.SorobanTransactionData.fromXDR(transactionData, 'base64');
  }

  if (typeof transactionData.build === 'function') {
    return transactionData.build();
  }

  if (typeof transactionData.resources === 'function') {
    return transactionData;
  }

  return null;
};

/**
 * Extracts read-only and read-write ledger footprints, compute/IO resource limits,
 * and minimum resource fees from a successful Soroban simulation response.
 */
const extractFootprint = (simulationResponse) => {
  if (!simulationResponse || typeof simulationResponse !== 'object') {
    throw new Error('Simulation response is required to extract footprint.');
  }

  const minResourceFee = toBigIntStroops(simulationResponse.minResourceFee, 0n);
  const sorobanData = resolveSorobanTransactionData(simulationResponse.transactionData);

  if (!sorobanData) {
    return {
      readOnly: [],
      readWrite: [],
      readOnlyXdr: [],
      readWriteXdr: [],
      readOnlyCount: 0,
      readWriteCount: 0,
      instructions: 0,
      readBytes: 0,
      writeBytes: 0,
      resourceFee: minResourceFee.toString(),
      minResourceFee: minResourceFee.toString(),
      sorobanData: null,
    };
  }

  const resources = sorobanData.resources();
  const footprint = resources.footprint();
  const readOnly = footprint.readOnly() || [];
  const readWrite = footprint.readWrite() || [];
  const resourceFee = sorobanData.resourceFee
    ? BigInt(sorobanData.resourceFee().toString())
    : minResourceFee;

  return {
    readOnly,
    readWrite,
    readOnlyXdr: readOnly.map((key) => key.toXDR('base64')),
    readWriteXdr: readWrite.map((key) => key.toXDR('base64')),
    readOnlyCount: readOnly.length,
    readWriteCount: readWrite.length,
    instructions: Number(resources.instructions()),
    readBytes: Number(resources.readBytes()),
    writeBytes: Number(resources.writeBytes()),
    resourceFee: resourceFee.toString(),
    minResourceFee: minResourceFee.toString(),
    sorobanData,
  };
};

/**
 * Calculates the final transaction fee in stroops from base fee and simulated
 * minimum resource fee, applying optional multiplier, buffer, and safety cap.
 */
const calculateTotalFee = (
  baseFeeStroops,
  minResourceFeeStroops,
  {
    resourceFeeMultiplier = DEFAULT_RESOURCE_FEE_MULTIPLIER,
    resourceFeeBufferStroops = DEFAULT_RESOURCE_FEE_BUFFER_STROOPS,
    maxFeeStroops = DEFAULT_MAX_FEE_STROOPS,
  } = {},
) => {
  const base = toBigIntStroops(baseFeeStroops, DEFAULT_BASE_FEE_STROOPS);
  const minResource = toBigIntStroops(minResourceFeeStroops, 0n);
  const buffer = toBigIntStroops(resourceFeeBufferStroops, 0n);
  const maxCap = maxFeeStroops !== null && maxFeeStroops !== undefined
    ? toBigIntStroops(maxFeeStroops, DEFAULT_MAX_FEE_STROOPS)
    : null;

  const multiplier = Number(resourceFeeMultiplier);
  if (!Number.isFinite(multiplier) || multiplier < 1) {
    throw new Error('resourceFeeMultiplier must be a finite number >= 1.');
  }

  // Scale in basis points (10_000 = 1.0x) to stay exact in BigInt arithmetic.
  const multiplierBps = BigInt(Math.ceil(multiplier * 10_000));
  const adjustedResourceFee = (minResource * multiplierBps + 9_999n) / 10_000n + buffer;
  const totalFee = base + adjustedResourceFee;

  if (maxCap !== null && totalFee > maxCap) {
    throw new SorobanFeeLimitError(
      `Simulated transaction fee (${totalFee.toString()} stroops) exceeds configured maximum (${maxCap.toString()} stroops).`,
      {
        requiredFeeStroops: totalFee.toString(),
        maxFeeStroops: maxCap.toString(),
      },
    );
  }

  return {
    baseFeeStroops: base.toString(),
    minResourceFeeStroops: minResource.toString(),
    adjustedResourceFeeStroops: adjustedResourceFee.toString(),
    totalFeeStroops: totalFee.toString(),
  };
};

/**
 * Validates that a transaction is a Soroban-capable unsigned Transaction
 * (ensuring simulation always precedes signing).
 */
const assertUnsignedTransaction = (transaction) => {
  if (!transaction || typeof transaction.toEnvelope !== 'function') {
    throw new Error('A valid Stellar Transaction instance is required for Soroban simulation.');
  }

  if (Array.isArray(transaction.signatures) && transaction.signatures.length > 0) {
    throw new Error(
      'Transaction is already signed. All Soroban contract invocations must be simulated and assembled before signing.',
    );
  }
};

/**
 * Injects extracted footprints, resource limits, auth entries, and total fee
 * into a new unsigned Transaction envelope ready for signing.
 */
const injectFootprintAndResources = (transaction, simulationResponse, options = {}) => {
  assertUnsignedTransaction(transaction);

  const networkPassphrase = options.networkPassphrase || transaction.networkPassphrase || getDefaultNetworkPassphrase();
  const baseFee = options.baseFeeStroops ?? transaction.fee ?? DEFAULT_BASE_FEE_STROOPS;
  const feeBreakdown = calculateTotalFee(baseFee, simulationResponse.minResourceFee, options);

  // Assemble using SDK's canonical Soroban assembler (injects footprint, sorobanData,
  // contract auth entries, and base + minResourceFee).
  const assembledBuilder = StellarSdk.rpc.assembleTransaction(transaction, simulationResponse);
  let preparedTx = assembledBuilder.build();

  // If custom multiplier or buffer raised the fee above SDK's default (base + minResourceFee),
  // rebuild the envelope cleanly with the adjusted total fee while keeping sorobanData intact.
  const desiredTotalFee = BigInt(feeBreakdown.totalFeeStroops);
  const assembledFee = BigInt(preparedTx.fee);

  if (desiredTotalFee > assembledFee) {
    const adjustedData = new StellarSdk.SorobanDataBuilder(preparedTx.toEnvelope().v1().tx().ext().sorobanData());
    const delta = desiredTotalFee - assembledFee;
    const currentResourceFee = BigInt(adjustedData.build().resourceFee().toString());
    adjustedData.setResourceFee((currentResourceFee + delta).toString());

    const cloned = StellarSdk.TransactionBuilder.cloneFrom(preparedTx, {
      fee: desiredTotalFee.toString(),
      networkPassphrase,
      sorobanData: adjustedData.build(),
    });
    preparedTx = cloned.build();
  }

  return {
    preparedTransaction: preparedTx,
    feeBreakdown,
  };
};

class SorobanSimulator {
  constructor({
    rpcServer = null,
    rpcUrl = getDefaultRpcUrl(),
    networkPassphrase = getDefaultNetworkPassphrase(),
    maxFeeStroops = DEFAULT_MAX_FEE_STROOPS,
    resourceFeeMultiplier = DEFAULT_RESOURCE_FEE_MULTIPLIER,
    resourceFeeBufferStroops = DEFAULT_RESOURCE_FEE_BUFFER_STROOPS,
    allowHttp = undefined,
    onSimulate = null,
  } = {}) {
    this._rpcServer = rpcServer;
    this.rpcUrl = rpcUrl;
    this.networkPassphrase = networkPassphrase;
    this.maxFeeStroops = maxFeeStroops;
    this.resourceFeeMultiplier = resourceFeeMultiplier;
    this.resourceFeeBufferStroops = resourceFeeBufferStroops;
    this.allowHttp = allowHttp;
    this.onSimulate = typeof onSimulate === 'function' ? onSimulate : null;
  }

  get rpcServer() {
    if (!this._rpcServer) {
      const allowHttp = this.allowHttp ?? (typeof this.rpcUrl === 'string' && this.rpcUrl.startsWith('http://'));
      this._rpcServer = new StellarSdk.rpc.Server(this.rpcUrl, { allowHttp });
    }
    return this._rpcServer;
  }

  /**
   * Simulates an unsigned Soroban transaction, validates it did not revert or require
   * state restoration, extracts footprints and resource fees, and injects them into
   * the prepared transaction envelope ready for signing.
   */
  async simulateAndPrepare(transaction, overrides = {}) {
    assertUnsignedTransaction(transaction);

    const simulationResponse = await this.rpcServer.simulateTransaction(transaction);

    if (this.onSimulate) {
      this.onSimulate({ transaction, simulationResponse });
    }

    if (StellarSdk.rpc.Api.isSimulationError(simulationResponse) || simulationResponse?.error) {
      const message = formatSimulationRevertMessage(simulationResponse);
      logger.warn('Soroban transaction simulation reverted', {
        error: simulationResponse?.error,
        latestLedger: simulationResponse?.latestLedger,
      });
      throw new SorobanSimulationError(message, {
        simulationError: simulationResponse?.error,
        events: simulationResponse?.events || [],
        latestLedger: simulationResponse?.latestLedger ?? null,
        rawResponse: simulationResponse,
      });
    }

    if (
      StellarSdk.rpc.Api.isSimulationRestore(simulationResponse)
      || simulationResponse?.restorePreamble
    ) {
      const preamble = simulationResponse.restorePreamble || {};
      logger.warn('Soroban transaction requires ledger state restoration before submission', {
        latestLedger: simulationResponse?.latestLedger,
        minResourceFee: preamble.minResourceFee,
      });
      throw new SorobanRestoreRequiredError(
        'Soroban contract state entries are archived and must be restored before invoking this transaction.',
        {
          restorePreamble: preamble,
          latestLedger: simulationResponse?.latestLedger ?? null,
          rawResponse: simulationResponse,
        },
      );
    }

    const footprint = extractFootprint(simulationResponse);
    const { preparedTransaction, feeBreakdown } = injectFootprintAndResources(
      transaction,
      simulationResponse,
      {
        networkPassphrase: overrides.networkPassphrase || this.networkPassphrase,
        baseFeeStroops: overrides.baseFeeStroops,
        maxFeeStroops: overrides.maxFeeStroops ?? this.maxFeeStroops,
        resourceFeeMultiplier: overrides.resourceFeeMultiplier ?? this.resourceFeeMultiplier,
        resourceFeeBufferStroops: overrides.resourceFeeBufferStroops ?? this.resourceFeeBufferStroops,
      },
    );

    return {
      preparedTransaction,
      xdr: preparedTransaction.toXDR(),
      footprint,
      minResourceFee: feeBreakdown.minResourceFeeStroops,
      totalFee: feeBreakdown.totalFeeStroops,
      feeBreakdown,
      result: simulationResponse.result || null,
      auth: simulationResponse.result?.auth || [],
      cost: simulationResponse.cost || null,
      latestLedger: simulationResponse.latestLedger ?? null,
      simulation: simulationResponse,
    };
  }

  /**
   * Builds a contract invocation transaction and runs it through the simulation
   * and footprint injection pipeline before returning an unsigned envelope for signing.
   */
  async prepareContractInvocation({
    sourceAccount,
    contractId,
    method,
    args = [],
    baseFeeStroops = DEFAULT_BASE_FEE_STROOPS.toString(),
    timeoutSeconds = 30,
    memo = null,
    ...overrides
  }) {
    if (!sourceAccount) {
      throw new Error('sourceAccount is required to prepare a Soroban contract invocation.');
    }
    if (!contractId || typeof contractId !== 'string') {
      throw new Error('contractId is required to prepare a Soroban contract invocation.');
    }
    if (!method || typeof method !== 'string') {
      throw new Error('method name is required to prepare a Soroban contract invocation.');
    }

    const contract = new StellarSdk.Contract(contractId);
    const networkPassphrase = overrides.networkPassphrase || this.networkPassphrase;
    const builder = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: String(baseFeeStroops),
      networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(timeoutSeconds);

    if (memo) {
      builder.addMemo(memo);
    }

    const unsignedTx = builder.build();
    return this.simulateAndPrepare(unsignedTx, {
      ...overrides,
      baseFeeStroops,
      networkPassphrase,
    });
  }
}

const createSorobanSimulator = (options = {}) => new SorobanSimulator(options);

const simulateAndPrepare = (transaction, options = {}) => {
  const simulator = new SorobanSimulator(options);
  return simulator.simulateAndPrepare(transaction, options);
};

module.exports = {
  SorobanSimulator,
  SorobanSimulationError,
  SorobanRestoreRequiredError,
  SorobanFeeLimitError,
  createSorobanSimulator,
  simulateAndPrepare,
  extractFootprint,
  calculateTotalFee,
  injectFootprintAndResources,
  formatSimulationRevertMessage,
  DEFAULT_MAX_FEE_STROOPS,
};
