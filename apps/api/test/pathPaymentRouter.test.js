const assert = require('node:assert/strict');
const { test } = require('node:test');
const { StellarSdk } = require('../src/config/stellar');
const { routePathPayment, readSourceDebit } = require('../src/payment/pathPaymentRouter');

const { Asset, Keypair, Operation, xdr } = StellarSdk;
const issuer = Keypair.random().publicKey();
const destination = Keypair.random().publicKey();
const source = new Asset('NGN', issuer);
const target = new Asset('GHS', issuer);
const nativeHop = { asset_type: 'native' };
const usdcHop = { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: issuer };
const record = (sourceAmount, destinationAmount, path) => ({
  source_amount: sourceAmount,
  source_asset_type: 'credit_alphanum4',
  source_asset_code: source.code,
  source_asset_issuer: issuer,
  destination_amount: destinationAmount,
  destination_asset_type: 'credit_alphanum4',
  destination_asset_code: target.code,
  destination_asset_issuer: issuer,
  path,
});

const search = (maxSource, receive, send = []) => ({
  strictReceivePaths: (assets, asset, amount) => {
    assert.deepEqual(assets, [source]);
    assert.equal(asset, target);
    assert.equal(amount, '10');
    return { call: async () => ({ records: receive }) };
  },
  strictSendPaths: (asset, amount, assets) => {
    assert.equal(asset, source);
    assert.equal(amount, maxSource);
    assert.deepEqual(assets, [target]);
    return { call: async () => ({ records: send }) };
  },
});

test('strict receive picks the lowest source debit and signs within the user cap', async () => {
  const maxSource = '3.004';
  const server = search(maxSource, [record('3.004', '10', []), record('3.00', '10', [nativeHop, usdcHop])]);
  const operation = Operation.fromXDRObject(await routePathPayment({
    server, source, target, maxSource, destination, destinationAmount: '10',
  }));
  assert.equal(operation.type, 'pathPaymentStrictReceive');
  assert.equal(operation.sendMax, '3.0040000');
  assert.equal(operation.destAmount, '10.0000000');
  assert.equal(operation.destination, destination);
  assert.deepEqual(operation.path.map((asset) => asset.code), ['XLM', 'USDC']);
});

test('strict send output breaks ties and a strict receive above the budget is rejected', async () => {
  const maxSource = '4';
  const server = search(maxSource, [record('3', '10', []), record('3', '10', [nativeHop])],
    [record('4', '15', []), record('4', '16', [nativeHop])]);
  const payment = { source, target, maxSource, destination, destinationAmount: '10' };
  const operation = Operation.fromXDRObject(await routePathPayment({ server, ...payment }));
  assert.equal(operation.sendMax, '3.0150000');
  assert.equal(operation.path[0].isNative(), true);
  await assert.rejects(routePathPayment({
    server: search('4', [record('4.0000001', '10', [])]), ...payment,
  }), { statusCode: 409 });
});

test('strict receive extracts the actual source debit from confirmed on-chain fills', () => {
  const fill = (bought, sold, amountBought) => xdr.ClaimAtom.claimAtomTypeLiquidityPool(new xdr.ClaimLiquidityAtom({
    liquidityPoolId: Buffer.alloc(32),
    assetSold: sold.toXDRObject(),
    assetBought: bought.toXDRObject(),
    amountSold: xdr.Int64.fromString('10000000'),
    amountBought: xdr.Int64.fromString(amountBought),
  }));
  const native = Asset.native();
  const success = new xdr.PathPaymentStrictReceiveResultSuccess({
    offers: [fill(native, target, '50000000'), fill(source, native, '29999999')],
    last: new xdr.SimplePaymentResult({
      destination: Keypair.fromPublicKey(destination).xdrAccountId(),
      asset: target.toXDRObject(),
      amount: xdr.Int64.fromString('100000000'),
    }),
  });
  const operation = xdr.OperationResult.opInner(xdr.OperationResultTr.pathPaymentStrictReceive(
    xdr.PathPaymentStrictReceiveResult.pathPaymentStrictReceiveSuccess(success),
  ));
  const result = new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString('100'),
    result: xdr.TransactionResultResult.txSuccess([operation]),
    ext: new xdr.TransactionResultExt(0),
  });

  assert.equal(readSourceDebit(result.toXDR('base64'), source), '2.9999999');
});
