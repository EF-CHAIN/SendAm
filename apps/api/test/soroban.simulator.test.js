const { test } = require('node:test');
const assert = require('node:assert/strict');
const StellarSdk = require('@stellar/stellar-sdk');

const {
  SorobanSimulator,
  SorobanSimulationError,
  SorobanRestoreRequiredError,
  SorobanFeeLimitError,
  extractFootprint,
  calculateTotalFee,
} = require('../src/blockchain/soroban.simulator');

const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;
const SAMPLE_CONTRACT_ID = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 7));

const buildUnsignedContractTx = ({ fee = '100', method = 'deposit', args = [] } = {}) => {
  const sourceKeypair = StellarSdk.Keypair.random();
  const account = new StellarSdk.Account(sourceKeypair.publicKey(), '100');
  const contract = new StellarSdk.Contract(SAMPLE_CONTRACT_ID);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();
  return { tx, sourceKeypair, account };
};

const buildMockSimulationSuccess = ({
  minResourceFee = '12500',
  instructions = 250000,
  readBytes = 2048,
  writeBytes = 512,
  latestLedger = 42000,
} = {}) => {
  const readKey = StellarSdk.xdr.LedgerKey.contractCode(
    new StellarSdk.xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, 1) }),
  );
  const writeKey = StellarSdk.xdr.LedgerKey.contractData(
    new StellarSdk.xdr.LedgerKeyContractData({
      contract: StellarSdk.Address.fromString(SAMPLE_CONTRACT_ID).toScAddress(),
      key: StellarSdk.nativeToScVal('escrow_1', { type: 'symbol' }),
      durability: StellarSdk.xdr.ContractDataDurability.persistent(),
    }),
  );

  const sorobanData = new StellarSdk.SorobanDataBuilder()
    .setReadOnly([readKey])
    .setReadWrite([writeKey])
    .setResources(instructions, readBytes, writeBytes)
    .setResourceFee(minResourceFee)
    .build();

  return StellarSdk.rpc.parseRawSimulation({
    id: 'sim-1',
    latestLedger,
    minResourceFee,
    transactionData: sorobanData.toXDR('base64'),
    results: [
      {
        auth: [],
        xdr: StellarSdk.nativeToScVal(true).toXDR('base64'),
      },
    ],
    cost: {
      cpuInsns: String(instructions),
      memBytes: '1048576',
    },
    events: [],
  });
};

test('simulateAndPrepare extracts read/write footprints, resource fees, and injects them into unsigned envelope', async () => {
  const { tx } = buildUnsignedContractTx({ fee: '100' });
  const mockSim = buildMockSimulationSuccess({
    minResourceFee: '15000',
    instructions: 300000,
    readBytes: 4096,
    writeBytes: 1024,
  });

  let simulatedCount = 0;
  const simulator = new SorobanSimulator({
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcServer: {
      simulateTransaction: async (inputTx) => {
        simulatedCount += 1;
        assert.equal(inputTx.signatures.length, 0);
        return mockSim;
      },
    },
  });

  const prepared = await simulator.simulateAndPrepare(tx);

  assert.equal(simulatedCount, 1);
  assert.equal(prepared.minResourceFee, '15000');
  assert.equal(prepared.totalFee, '15100');
  assert.equal(prepared.footprint.readOnlyCount, 1);
  assert.equal(prepared.footprint.readWriteCount, 1);
  assert.equal(prepared.footprint.instructions, 300000);
  assert.equal(prepared.footprint.readBytes, 4096);
  assert.equal(prepared.footprint.writeBytes, 1024);
  assert.equal(prepared.preparedTransaction.fee, '15100');
  assert.equal(prepared.preparedTransaction.signatures.length, 0);

  // Verify the XDR envelope actually carries the injected SorobanData footprint.
  const envelopeSorobanData = prepared.preparedTransaction.toEnvelope().v1().tx().ext().sorobanData();
  assert.equal(envelopeSorobanData.resources().footprint().readOnly().length, 1);
  assert.equal(envelopeSorobanData.resources().footprint().readWrite().length, 1);
});

test('simulateAndPrepare applies resourceFeeMultiplier and resourceFeeBufferStroops cleanly', async () => {
  const { tx } = buildUnsignedContractTx({ fee: '100' });
  const mockSim = buildMockSimulationSuccess({ minResourceFee: '10000' });

  const simulator = new SorobanSimulator({
    networkPassphrase: NETWORK_PASSPHRASE,
    resourceFeeMultiplier: 1.2,
    resourceFeeBufferStroops: 500,
    rpcServer: {
      simulateTransaction: async () => mockSim,
    },
  });

  const prepared = await simulator.simulateAndPrepare(tx);

  // base 100 + (10000 * 1.2 = 12000) + buffer 500 = 12600
  assert.equal(prepared.totalFee, '12600');
  assert.equal(prepared.preparedTransaction.fee, '12600');
  assert.equal(prepared.preparedTransaction.signatures.length, 0);
});

test('simulateAndPrepare rejects already-signed transactions to enforce simulate-before-sign', async () => {
  const { tx, sourceKeypair } = buildUnsignedContractTx();
  tx.sign(sourceKeypair);

  let called = false;
  const simulator = new SorobanSimulator({
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcServer: {
      simulateTransaction: async () => {
        called = true;
        return buildMockSimulationSuccess();
      },
    },
  });

  await assert.rejects(
    simulator.simulateAndPrepare(tx),
    /already signed/i,
  );
  assert.equal(called, false);
});

test('simulateAndPrepare fails early with clear SorobanSimulationError when contract reverts', async () => {
  const { tx } = buildUnsignedContractTx();

  const simulator = new SorobanSimulator({
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcServer: {
      simulateTransaction: async () => ({
        id: 'sim-err',
        latestLedger: 42001,
        error: 'HostError: Error(Contract, #6)',
        events: ['diagnostic-event-1'],
      }),
    },
  });

  await assert.rejects(
    simulator.simulateAndPrepare(tx),
    (err) => {
      assert.ok(err instanceof SorobanSimulationError);
      assert.equal(err.code, 'SOROBAN_SIMULATION_REVERTED');
      assert.match(err.message, /contract error #6/i);
      assert.equal(err.latestLedger, 42001);
      assert.deepEqual(err.events, ['diagnostic-event-1']);
      return true;
    },
  );
});

test('simulateAndPrepare throws SorobanRestoreRequiredError when archived state needs restoration', async () => {
  const { tx } = buildUnsignedContractTx();
  const restoreData = new StellarSdk.SorobanDataBuilder().setResourceFee('8000');

  const simulator = new SorobanSimulator({
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcServer: {
      simulateTransaction: async () => ({
        id: 'sim-restore',
        latestLedger: 42005,
        minResourceFee: '12000',
        transactionData: new StellarSdk.SorobanDataBuilder(),
        restorePreamble: {
          minResourceFee: '8000',
          transactionData: restoreData,
        },
      }),
    },
  });

  await assert.rejects(
    simulator.simulateAndPrepare(tx),
    (err) => {
      assert.ok(err instanceof SorobanRestoreRequiredError);
      assert.equal(err.code, 'SOROBAN_RESTORE_REQUIRED');
      assert.equal(err.restorePreamble.minResourceFee, '8000');
      return true;
    },
  );
});

test('simulateAndPrepare enforces maxFeeStroops safety cap', async () => {
  const { tx } = buildUnsignedContractTx({ fee: '100' });
  const mockSim = buildMockSimulationSuccess({ minResourceFee: '500000' });

  const simulator = new SorobanSimulator({
    networkPassphrase: NETWORK_PASSPHRASE,
    maxFeeStroops: 100000,
    rpcServer: {
      simulateTransaction: async () => mockSim,
    },
  });

  await assert.rejects(
    simulator.simulateAndPrepare(tx),
    (err) => {
      assert.ok(err instanceof SorobanFeeLimitError);
      assert.equal(err.code, 'SOROBAN_FEE_LIMIT_EXCEEDED');
      assert.equal(err.requiredFeeStroops, '500100');
      assert.equal(err.maxFeeStroops, '100000');
      return true;
    },
  );
});

test('prepareContractInvocation builds contract call and runs through simulation pipeline', async () => {
  const sourceKeypair = StellarSdk.Keypair.random();
  const sourceAccount = new StellarSdk.Account(sourceKeypair.publicKey(), '50');
  const mockSim = buildMockSimulationSuccess({ minResourceFee: '22000' });

  const simulator = new SorobanSimulator({
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcServer: {
      simulateTransaction: async () => mockSim,
    },
  });

  const prepared = await simulator.prepareContractInvocation({
    sourceAccount,
    contractId: SAMPLE_CONTRACT_ID,
    method: 'release',
    args: [StellarSdk.nativeToScVal(1n, { type: 'u64' })],
    baseFeeStroops: '200',
  });

  assert.equal(prepared.totalFee, '22200');
  assert.equal(prepared.footprint.readOnlyCount, 1);
  assert.equal(prepared.footprint.readWriteCount, 1);
  // Caller can now sign the prepared envelope after simulation succeeded.
  prepared.preparedTransaction.sign(sourceKeypair);
  assert.equal(prepared.preparedTransaction.signatures.length, 1);
});

test('extractFootprint supports base64-encoded SorobanTransactionData XDR', () => {
  const mockSim = buildMockSimulationSuccess({ minResourceFee: '9000' });
  const base64Data = mockSim.transactionData.build().toXDR('base64');

  const extracted = extractFootprint({
    minResourceFee: '9000',
    transactionData: base64Data,
  });

  assert.equal(extracted.readOnlyCount, 1);
  assert.equal(extracted.readWriteCount, 1);
  assert.equal(extracted.minResourceFee, '9000');
  assert.equal(extracted.readOnlyXdr.length, 1);
  assert.equal(extracted.readWriteXdr.length, 1);
});

test('calculateTotalFee validates multiplier bounds', () => {
  assert.throws(
    () => calculateTotalFee('100', '1000', { resourceFeeMultiplier: 0.5 }),
    /resourceFeeMultiplier/i,
  );
});
