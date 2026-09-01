const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

let queryRawRows = [];
let exchangeRateByAsset = {};
const fakePrisma = {
  user: { count: async () => 0 },
  wallet: { count: async () => 0 },
  transaction: { count: async () => 0 },
  kycProfile: { count: async () => 0 },
  voiceCommand: { count: async () => 0 },
  $queryRaw: async () => queryRawRows,
};
inject('common/prisma', fakePrisma);
inject('pricing/pricing.service', {
  getExchangeRate: async ({ sourceCurrency, targetCurrency }) => {
    const key = `${sourceCurrency}:${targetCurrency}`;
    if (key in exchangeRateByAsset) return exchangeRateByAsset[key];
    throw new Error(`no rate stubbed for ${key}`);
  },
});

const controller = require('../src/controllers/admin.controller');

const makeRes = () => {
  const res = { statusCode: 200 };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

beforeEach(() => {
  queryRawRows = [];
  exchangeRateByAsset = {};
});

test('balances includes the base currency asset at identity rate', async () => {
  queryRawRows = [{ asset: 'USD', total: '150' }];
  const res = makeRes();
  await controller.getStats({}, res, () => {});
  assert.equal(res.body.data.balances.length, 1);
  assert.deepEqual(res.body.data.balances[0], {
    asset: 'USD', amount: '150.00', precision: 2, baseCurrency: 'USD', baseAmount: '150.00', rate: '1', source: 'identity',
  });
});

test('non-base assets are converted using the pricing service and labeled with their source', async () => {
  queryRawRows = [{ asset: 'XLM', total: '1000' }];
  exchangeRateByAsset['XLM:USD'] = '0.5';
  const res = makeRes();
  await controller.getStats({}, res, () => {});
  const row = res.body.data.balances[0];
  assert.equal(row.asset, 'XLM');
  assert.equal(row.precision, 7);
  assert.equal(row.baseAmount, '500.00');
  assert.equal(row.rate, '0.5');
  assert.equal(row.source, 'exchangerate-api');
});

test('an unavailable rate leaves baseAmount null instead of guessing', async () => {
  queryRawRows = [{ asset: 'XLM', total: '1000' }];
  // no stub registered for XLM:USD, so getExchangeRate rejects
  const res = makeRes();
  await controller.getStats({}, res, () => {});
  const row = res.body.data.balances[0];
  assert.equal(row.baseAmount, null);
  assert.equal(row.source, 'unavailable');
});

test('an asset with no configured precision rule is reported without breaking the response', async () => {
  queryRawRows = [{ asset: 'DOGE', total: '42' }];
  const res = makeRes();
  await controller.getStats({}, res, () => {});
  const row = res.body.data.balances[0];
  assert.equal(row.asset, 'DOGE');
  assert.equal(row.baseAmount, null);
  assert.equal(row.source, 'unsupported_asset');
});

test('multiple settled assets are all summarized', async () => {
  queryRawRows = [{ asset: 'USD', total: '10' }, { asset: 'EUR', total: '20' }];
  exchangeRateByAsset['EUR:USD'] = '1.1';
  const res = makeRes();
  await controller.getStats({}, res, () => {});
  assert.equal(res.body.data.balances.length, 2);
  assert.equal(res.body.data.totalUsers, 0);
});
