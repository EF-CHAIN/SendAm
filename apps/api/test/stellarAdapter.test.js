const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const stellarAdapter = require('../src/wallet/stellar.adapter');
const { server, StellarSdk } = require('../src/config/stellar');
const config = require('../src/config/env');

const USDC_ISSUER = config.stellar.usdcIssuer;
const OTHER_ISSUER = 'GAQAA5L65LSYH7CQ3VTJ7F3HHNTNCQIKEO7YPC2FUYAKQNRFAWSFTNZK';

const SOURCE_WALLET = stellarAdapter.createWallet();
const DESTINATION_WALLET = stellarAdapter.createWallet();

const SOURCE_SECRET = SOURCE_WALLET.secretKey;
const SOURCE_PUBLIC_KEY = SOURCE_WALLET.publicKey;
const DESTINATION_PUBLIC_KEY = DESTINATION_WALLET.publicKey;

const mockSuccessfulPaymentSetup = () => {
  mock.method(server, 'loadAccount', async () => {
    return new StellarSdk.Account(SOURCE_PUBLIC_KEY, '1');
  });

  mock.method(server, 'fetchBaseFee', async () => '100');

  mock.method(server, 'submitTransaction', async () => ({
    hash: 'mock-transaction-hash',
  }));
};

test('submitPayment returns a friendly error for op_no_trust', async () => {
  mockSuccessfulPaymentSetup();

  mock.method(server, 'submitTransaction', async () => {
    const error = new Error('Transaction failed');

    error.response = {
      data: {
        extras: {
          result_codes: {
            transaction: 'tx_failed',
            operations: ['op_no_trust'],
          },
        },
      },
    };

    throw error;
  });

  await assert.rejects(
    stellarAdapter.submitPayment({
      secretKey: SOURCE_SECRET,
      destination: DESTINATION_PUBLIC_KEY,
      amount: '10',
      asset: 'XLM',
    }),
    {
      message: "The recipient can't receive USDC yet.",
    },
  );
});

test('submitPayment returns a friendly error for op_underfunded', async () => {
  mockSuccessfulPaymentSetup();

  mock.method(server, 'fetchBaseFee', async () => '100');

  mock.method(server, 'submitTransaction', async () => {
    const error = new Error('Transaction failed');
    error.response = {
      data: {
        extras: {
          result_codes: {
            transaction: 'tx_failed',
            operations: ['op_underfunded'],
          },
        },
      },
    };

    throw error;
  });

  await assert.rejects(
    stellarAdapter.submitPayment({
      secretKey: SOURCE_SECRET,
      destination: DESTINATION_PUBLIC_KEY,
      amount: '10',
      asset: 'XLM',
    }),
    {
      message: 'Insufficient balance for this payment.',
    },
  );
});

test('submitPayment preserves unknown Horizon errors unchanged', async () => {
  mockSuccessfulPaymentSetup();

  const originalError = new Error('Transaction failed');

  originalError.response = {
    data: {
      extras: {
        result_codes: {
          transaction: 'tx_failed',
          operations: ['op_line_full'],
        },
      },
    },
  };

  mock.method(server, 'submitTransaction', async () => {
    throw originalError;
  });

  await assert.rejects(
    stellarAdapter.submitPayment({
      secretKey: SOURCE_SECRET,
      destination: DESTINATION_PUBLIC_KEY,
      amount: '10',
      asset: 'XLM',
    }),
    {
      message: 'Transaction failed',
    },
  );
});

test('createWallet returns a valid Stellar keypair', () => {
  const { publicKey, secretKey } = stellarAdapter.createWallet();
  assert.equal(typeof publicKey, 'string');
  assert.equal(publicKey[0], 'G');
  assert.equal(publicKey.length, 56);
  assert.equal(secretKey[0], 'S');
  assert.equal(stellarAdapter.validateAddress(publicKey), true);
});

test('validateAddress rejects non-Stellar input', () => {
  assert.equal(stellarAdapter.validateAddress('0xab12ab12ab12ab12ab12ab12ab12ab12ab12ab12'), false);
  assert.equal(stellarAdapter.validateAddress('not-an-address'), false);
  assert.equal(stellarAdapter.validateAddress(''), false);
  assert.equal(stellarAdapter.validateAddress(null), false);
  // Right shape, wrong checksum.
  assert.equal(stellarAdapter.validateAddress(`G${'A'.repeat(55)}`), false);
});

test('resolveAsset maps XLM/native and rejects unknown assets', () => {
  assert.equal(stellarAdapter.resolveAsset('XLM').isNative(), true);
  assert.equal(stellarAdapter.resolveAsset('native').isNative(), true);
  assert.equal(stellarAdapter.resolveAsset(undefined).isNative(), true);
  assert.throws(() => stellarAdapter.resolveAsset('DOGE'), /Unsupported asset/);
});

test('adapter identifies as the stellar chain', () => {
  assert.equal(stellarAdapter.chain, 'stellar');
});

afterEach(() => {
  mock.restoreAll();
});

test('getBalances returns XLM and USDC rows when both trustlines exist', async () => {
  mock.method(server, 'loadAccount', async () => ({
    balances: [
      { asset_type: 'native', balance: '42.5000000' },
      { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, balance: '10.0000000' },
    ],
  }));

  const balances = await stellarAdapter.getBalances('GABCD');
  assert.deepEqual(balances, [
    { asset: 'XLM', value: '42.5000000' },
    { asset: 'USDC', value: '10.0000000' },
  ]);
});

test('getBalances returns only XLM for an XLM-only account', async () => {
  mock.method(server, 'loadAccount', async () => ({
    balances: [{ asset_type: 'native', balance: '5.0000000' }],
  }));

  const balances = await stellarAdapter.getBalances('GABCD');
  assert.deepEqual(balances, [{ asset: 'XLM', value: '5.0000000' }]);
});

test('getBalances ignores a USDC-code trustline from an untrusted issuer', async () => {
  mock.method(server, 'loadAccount', async () => ({
    balances: [
      { asset_type: 'native', balance: '1.0000000' },
      { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: OTHER_ISSUER, balance: '999.0000000' },
    ],
  }));

  const balances = await stellarAdapter.getBalances('GABCD');
  assert.deepEqual(balances, [{ asset: 'XLM', value: '1.0000000' }]);
});
