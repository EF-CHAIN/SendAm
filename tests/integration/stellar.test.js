const assert = require('node:assert/strict');
const test = require('node:test');

test('a Friendbot-funded XLM payment is confirmed on Stellar testnet', {
  skip: process.env.RUN_STELLAR_INTEGRATION !== 'true' && 'Set RUN_STELLAR_INTEGRATION=true to use live testnet',
  timeout: 120_000,
}, async (t) => {
  const { NETWORK_PROFILES } = require('../../apps/api/src/config/networkProfiles');
  const { stellar } = require('../../apps/api/src/config/env');
  const { server, StellarSdk, baseUrls } = require('../../apps/api/src/config/stellar');
  const { createWallet, submitPayment } = require('../../apps/api/src/wallet/stellar.adapter');
  const { defaultHorizonUrl, friendbotUrl } = NETWORK_PROFILES.testnet;

  assert.equal(stellar.network, 'testnet');
  assert.deepEqual(baseUrls, [defaultHorizonUrl]);
  StellarSdk.Horizon.AxiosClient.defaults.timeout = 15_000;

  const sender = createWallet();
  const recipient = createWallet();
  for (const { publicKey } of [sender, recipient]) {
    const url = new URL(friendbotUrl);
    url.searchParams.set('addr', publicKey);
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    assert.ok(response.ok, `Friendbot funding failed with HTTP ${response.status}`);
    await response.body?.cancel();
  }

  const amount = '1.0000000';
  const { txHash } = await submitPayment({
    secretKey: sender.secretKey,
    destination: recipient.publicKey,
    amount,
  });

  assert.match(txHash, /^[0-9a-f]{64}$/);
  const transaction = await server.transactions().transaction(txHash).call();
  assert.equal(transaction.hash, txHash);
  assert.equal(transaction.successful, true);
  const { ledger_attr: ledger } = transaction;
  assert.ok(Number.isInteger(ledger) && ledger > 0, 'expected a confirmed ledger');

  const { records } = await server.payments().forTransaction(txHash).call();
  assert.equal(records.length, 1);
  const [{ type, asset_type: assetType, from, to, amount: paid }] = records;
  assert.deepEqual({ type, assetType, from, to, paid }, {
    type: 'payment',
    assetType: 'native',
    from: sender.publicKey,
    to: recipient.publicKey,
    paid: amount,
  });
  t.diagnostic(`Confirmed ${txHash} in testnet ledger ${ledger}`);
});
