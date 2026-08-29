const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const calls = { balance: null, sender: null };
const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
inject('wallet/wallet.service', {
  balancesForUser: mock.fn(async (args) => { calls.balance = args; return [{ asset: 'XLM', value: '1' }]; }),
  transactionHistory: mock.fn(async () => []),
  ensureWalletsForUser: mock.fn(async () => []),
});
inject('wallet/stellar.adapter', { validateAddress: () => true });
inject('payment/payment.orchestrator', {
  executePayment: mock.fn(async (args) => {
    calls.sender = args.sender;
    return { transaction: { _id: 'tx1', status: 'success', rail: 'stellar' }, receipt: {} };
  }),
});

const controller = require('../src/controllers/wallet.controller');
const owner = { id: 'owner', phoneNumber: '+2348000000001' };
const response = () => ({ status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('balance ignores a changed path phone and uses the session owner', async () => {
  const res = response();
  await controller.checkBalance({ restUser: owner, params: { phone: '+2348999999999' } }, res, assert.fail);
  assert.deepEqual(calls.balance, { phoneNumber: owner.phoneNumber });
  assert.equal(res.statusCode, 200);
});

test('send ignores a changed body phone and charges the session owner', async () => {
  const res = response();
  await controller.sendFunds({
    restUser: owner,
    body: { phoneNumber: '+2348999999999', amount: '1', destination: 'GDESTINATION' },
  }, res, assert.fail);
  assert.equal(calls.sender, owner);
  assert.equal(res.statusCode, 200);
});
