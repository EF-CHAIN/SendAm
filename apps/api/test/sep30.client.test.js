const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} = require('@stellar/stellar-sdk');

const {
  Sep30Client,
  Sep30RecoveryCoordinator,
  Sep30RecoveryError,
} = require('../src/services/sep30.client');

const createMockSep30Server = (signerKeypair, expectedToken) => {
  const accounts = new Map();
  return {
    post: async (url, body, config) => {
      assert.equal(config.headers.Authorization, `Bearer ${expectedToken}`);
      const signMatch = url.match(/\/accounts\/([^/]+)\/sign\/([^/]+)$/);
      if (signMatch) {
        const tx = TransactionBuilder.fromXDR(body.transaction, Networks.TESTNET);
        const signature = signerKeypair.sign(tx.hash()).toString('base64');
        return { data: { signature, network_passphrase: Networks.TESTNET } };
      }
      const regMatch = url.match(/\/accounts\/([^/]+)$/);
      if (regMatch) {
        const address = decodeURIComponent(regMatch[1]);
        const record = {
          address,
          identities: body.identities,
          signers: [{ key: signerKeypair.publicKey() }],
        };
        accounts.set(address, record);
        return { data: record };
      }
      throw new Error(`Unexpected POST ${url}`);
    },
    get: async (url) => {
      const regMatch = url.match(/\/accounts\/([^/]+)$/);
      const address = decodeURIComponent(regMatch[1]);
      return { data: accounts.get(address) };
    },
  };
};

test('Sep30RecoveryCoordinator registers identities and executes 2-of-2 threshold recovery', async () => {
  const userKeypair = Keypair.random();
  const newOwnerKeypair = Keypair.random();
  const signer1 = Keypair.random();
  const signer2 = Keypair.random();

  const client1 = new Sep30Client({
    serverUrl: 'https://recovery-1.sendam.local',
    httpClient: createMockSep30Server(signer1, 'tok-1'),
  });
  const client2 = new Sep30Client({
    serverUrl: 'https://recovery-2.sendam.local',
    httpClient: createMockSep30Server(signer2, 'tok-2'),
  });

  const coordinator = new Sep30RecoveryCoordinator({
    servers: [
      { id: 'rs1', client: client1 },
      { id: 'rs2', client: client2 },
    ],
    threshold: 2,
    networkPassphrase: Networks.TESTNET,
  });

  const identities = [
    {
      role: 'owner',
      auth_methods: [
        { type: 'phone_number', value: '+2348012345678' },
        { type: 'email', value: 'ada@example.com' },
      ],
    },
  ];

  const registration = await coordinator.registerRecovery({
    address: userKeypair.publicKey(),
    identities,
    authTokens: { rs1: 'tok-1', rs2: 'tok-2' },
  });

  assert.equal(registration.signers.length, 2);
  assert.equal(registration.signers[0].key, signer1.publicKey());
  assert.equal(registration.signers[1].key, signer2.publicKey());

  // Build recovery transaction rotating master weight to a new signer
  const recoveryTx = new TransactionBuilder(new Account(userKeypair.publicKey(), '100'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.setOptions({
      signer: { ed25519PublicKey: newOwnerKeypair.publicKey(), weight: 2 },
      masterWeight: 0,
    }))
    .setTimeout(300)
    .build();

  const recovered = await coordinator.recoverAccount({
    address: userKeypair.publicKey(),
    transactionXdr: recoveryTx.toXDR(),
    authTokens: { rs1: 'tok-1', rs2: 'tok-2' },
  });

  assert.equal(recovered.signaturesCollected, 2);
  assert.deepEqual(recovered.signersUsed, [signer1.publicKey(), signer2.publicKey()]);

  const signedTx = TransactionBuilder.fromXDR(recovered.transactionXdr, Networks.TESTNET);
  assert.equal(signedTx.signatures.length, 2);
  assert.equal(signer1.verify(signedTx.hash(), signedTx.signatures[0].signature()), true);
  assert.equal(signer2.verify(signedTx.hash(), signedTx.signatures[1].signature()), true);
});

test('Sep30RecoveryCoordinator throws Sep30RecoveryError when threshold signatures cannot be met', async () => {
  const userKeypair = Keypair.random();
  const signer1 = Keypair.random();
  const client1 = new Sep30Client({
    serverUrl: 'https://recovery-1.sendam.local',
    httpClient: createMockSep30Server(signer1, 'tok-1'),
  });

  const coordinator = new Sep30RecoveryCoordinator({
    servers: [{ id: 'rs1', client: client1, signingAddress: signer1.publicKey() }],
    threshold: 2,
    networkPassphrase: Networks.TESTNET,
  });

  const tx = new TransactionBuilder(new Account(userKeypair.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.setOptions({ masterWeight: 1 }))
    .setTimeout(300)
    .build();

  await assert.rejects(
    () => coordinator.recoverAccount({
      address: userKeypair.publicKey(),
      transactionXdr: tx.toXDR(),
      authTokens: { rs1: 'tok-1' },
    }),
    (err) => err instanceof Sep30RecoveryError && /Insufficient recovery signatures/.test(err.message),
  );
});
