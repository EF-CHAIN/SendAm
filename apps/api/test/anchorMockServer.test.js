const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, TransactionBuilder } = require('@stellar/stellar-sdk');

const { createAnchorMockServer } = require('./mocks/anchorServer');

test('Anchor Mock Server runs full offline SEP-10, SEP-24, SEP-38, and SEP-31 flow deterministically', async () => {
  const mock = createAnchorMockServer();
  const base = await mock.start();

  try {
    // 1. Discovery
    const tomlRes = await fetch(`${base}/.well-known/stellar.toml`);
    assert.equal(tomlRes.status, 200);
    const toml = await tomlRes.text();
    assert.match(toml, /WEB_AUTH_ENDPOINT=/);
    assert.match(toml, /TRANSFER_SERVER_SEP0024=/);

    // 2. SEP-10 Auth
    const clientKp = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));
    const challengeRes = await fetch(`${base}/auth?account=${clientKp.publicKey()}`);
    assert.equal(challengeRes.status, 200);
    const { transaction: challengeXdr, network_passphrase: passphrase } = await challengeRes.json();

    const challengeTx = TransactionBuilder.fromXDR(challengeXdr, passphrase);
    challengeTx.sign(clientKp);

    const tokenRes = await fetch(`${base}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transaction: challengeTx.toXDR() }),
    });
    assert.equal(tokenRes.status, 200);
    const { token } = await tokenRes.json();
    assert.ok(token);

    const authHeaders = {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    };

    // 3. SEP-24 Interactive Deposit + Webview simulation
    const depRes = await fetch(`${base}/sep24/transactions/deposit/interactive`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ asset_code: 'USDC', amount: '50' }),
    });
    assert.equal(depRes.status, 200);
    const dep = await depRes.json();
    assert.equal(dep.type, 'interactive_customer_info_needed');
    assert.equal(dep.id, 'sep24-deposit-1');

    const webviewRes = await fetch(dep.url);
    assert.equal(webviewRes.status, 200);
    assert.match(await webviewRes.text(), /Mock SEP-24 deposit/);

    const completeRes = await fetch(`${base}/sep24/webview/${dep.id}/complete`, { method: 'POST' });
    assert.equal(completeRes.status, 200);
    const { transaction: completedTx } = await completeRes.json();
    assert.equal(completedTx.status, 'completed');

    // 4. SEP-38 Quote
    const quoteRes = await fetch(`${base}/sep38/quote`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        sell_asset: 'iso4217:NGN',
        buy_asset: 'stellar:USDC',
        sell_amount: '16000',
      }),
    });
    assert.equal(quoteRes.status, 201);
    const quote = await quoteRes.json();
    assert.equal(quote.id, 'quote-2');
    assert.equal(quote.buy_amount, '10.00');

    // 5. SEP-31 Remittance referencing SEP-38 quote
    const sep31Res = await fetch(`${base}/sep31/transactions`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        amount: '16000',
        asset_code: 'NGN',
        quote_id: quote.id,
      }),
    });
    assert.equal(sep31Res.status, 201);
    const sep31 = await sep31Res.json();
    assert.equal(sep31.id, 'sep31-3');
    assert.equal(sep31.stellar_account_id, mock.serverKeypair.publicKey());

    // 6. Reset guarantees 100% determinism on next run
    mock.reset();
    const depAgain = await fetch(`${base}/sep24/transactions/deposit/interactive`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ asset_code: 'USDC', amount: '50' }),
    });
    assert.equal((await depAgain.json()).id, 'sep24-deposit-1');
  } finally {
    await mock.stop();
  }
});
