'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const sep38Client = require('../src/services/sep38.client');
const { TESTNET_USDC_ISSUER } = require('../src/config/networkProfiles');

const firmQuotes = new Map();
let quoteMode = 'ok';

const createMockSep38Server = () => {
  const app = express();
  app.use(express.json());

  const requireBearer = (req, res, next) => {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'authentication required' });
    }
    return next();
  };

  app.get('/info', (_req, res) => {
    res.status(200).json({
      assets: [
        { asset: `stellar:USDC:${TESTNET_USDC_ISSUER}` },
        { asset: 'iso4217:NGN', country_codes: ['NG'], sell_delivery_methods: [{ name: 'bank_transfer' }] },
        { asset: 'iso4217:KES', country_codes: ['KE'], buy_delivery_methods: [{ name: 'mpesa' }] },
      ],
    });
  });

  app.get('/prices', (req, res) => {
    const sellAmount = req.query.sell_amount;
    if (sellAmount) {
      return res.status(200).json({
        buy_assets: [
          { asset: 'iso4217:NGN', price: '0.000645', decimals: 2 },
          { asset: 'iso4217:KES', price: '0.00775', decimals: 2 },
        ],
      });
    }
    return res.status(200).json({
      sell_assets: [
        { asset: `stellar:USDC:${TESTNET_USDC_ISSUER}`, price: '1550.00', decimals: 7 },
      ],
    });
  });

  app.get('/price', (req, res) => {
    const sellAmount = req.query.sell_amount || '100';
    return res.status(200).json({
      total_price: '0.00064516',
      price: '0.00064516',
      sell_amount: String(sellAmount),
      buy_amount: '155000.00',
      fee: { total: '0.50', asset: req.query.sell_asset },
    });
  });

  app.post('/quote', requireBearer, (req, res) => {
    if (quoteMode === 'already_expired') {
      return res.status(201).json({
        id: 'anchor-q-expired',
        expires_at: new Date(Date.now() - 5000).toISOString(),
        total_price: '0.000645',
        price: '0.000645',
        sell_asset: req.body.sell_asset,
        sell_amount: req.body.sell_amount || '100',
        buy_asset: req.body.buy_asset,
        buy_amount: '155000.00',
      });
    }
    if (quoteMode === 'bad_pair') {
      return res.status(400).json({ error: 'unsupported currency pair' });
    }

    const id = `anchor-q-${firmQuotes.size + 1}`;
    const expiresAt = req.body.expire_after || new Date(Date.now() + 60000).toISOString();
    const record = {
      id,
      expires_at: expiresAt,
      total_price: '1550.00',
      price: '1540.00',
      sell_asset: req.body.sell_asset,
      sell_amount: req.body.sell_amount || '100',
      buy_asset: req.body.buy_asset,
      buy_amount: req.body.buy_amount || '155000.00',
      fee: {
        total: '1.00',
        asset: req.body.sell_asset,
        details: [{ name: 'anchor_spread', amount: '1.00' }],
      },
    };
    firmQuotes.set(id, record);
    return res.status(201).json(record);
  });

  app.get('/quote/:id', requireBearer, (req, res) => {
    const record = firmQuotes.get(req.params.id);
    if (!record) return res.status(404).json({ error: 'quote not found' });
    return res.status(200).json(record);
  });

  return app;
};

const withSep38Server = async (run) => {
  const server = http.createServer(createMockSep38Server());
  await new Promise((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

beforeEach(() => {
  firmQuotes.clear();
  quoteMode = 'ok';
});

describe('SEP-38 RFQ and Firm Quote Client (#948)', () => {
  test('converts and parses SEP-38 asset identifiers cleanly', () => {
    assert.equal(sep38Client.formatStellarAsset('XLM'), 'stellar:native');
    assert.equal(sep38Client.formatStellarAsset('USDC'), `stellar:USDC:${TESTNET_USDC_ISSUER}`);
    assert.equal(sep38Client.formatFiatAsset('ngn'), 'iso4217:NGN');
    assert.equal(sep38Client.toSep38AssetId('USDC'), `stellar:USDC:${TESTNET_USDC_ISSUER}`);
    assert.equal(sep38Client.toSep38AssetId('KES'), 'iso4217:KES');

    assert.deepEqual(sep38Client.parseSep38AssetId('stellar:native'), {
      scheme: 'stellar',
      code: 'XLM',
      issuer: null,
      isNative: true,
    });
    assert.deepEqual(sep38Client.parseSep38AssetId('iso4217:NGN'), {
      scheme: 'iso4217',
      code: 'NGN',
      issuer: null,
      isNative: false,
    });
    assert.deepEqual(sep38Client.parseSep38AssetId(`stellar:USDC:${TESTNET_USDC_ISSUER}`), {
      scheme: 'stellar',
      code: 'USDC',
      issuer: TESTNET_USDC_ISSUER,
      isNative: false,
    });
  });

  test('queries /info, /prices, /price, creates firm quote via POST /quote, and fetches GET /quote/:id', async () => {
    await withSep38Server(async (baseUrl) => {
      const info = await sep38Client.getInfo({ quoteServerUrl: baseUrl });
      assert.equal(info.assets.length, 3);

      const prices = await sep38Client.getPrices({
        quoteServerUrl: baseUrl,
        sellAsset: `stellar:USDC:${TESTNET_USDC_ISSUER}`,
        sellAmount: '100',
      });
      assert.equal(prices.buy_assets.length, 2);

      const price = await sep38Client.getPrice({
        quoteServerUrl: baseUrl,
        sellAsset: `stellar:USDC:${TESTNET_USDC_ISSUER}`,
        buyAsset: 'iso4217:NGN',
        sellAmount: '100',
        context: 'sep31',
      });
      assert.equal(price.buyAmount, '155000.00');
      assert.equal(price.totalPrice, '0.00064516');

      const expireAfter = new Date(Date.now() + 60000).toISOString();
      const firm = await sep38Client.createFirmQuote({
        quoteServerUrl: baseUrl,
        jwt: 'sep10-jwt',
        sellAsset: `stellar:USDC:${TESTNET_USDC_ISSUER}`,
        buyAsset: 'iso4217:NGN',
        sellAmount: '100',
        context: 'sep31',
        expireAfter,
      });

      assert.equal(firm.anchorQuoteId, 'anchor-q-1');
      assert.equal(firm.expiresAtIso, expireAfter);
      assert.equal(firm.buyAmount, '155000.00');
      assert.equal(firm.fee.total, '1.00');

      const fetched = await sep38Client.getFirmQuote({
        quoteServerUrl: baseUrl,
        jwt: 'sep10-jwt',
        id: firm.anchorQuoteId,
      });
      assert.equal(fetched.anchorQuoteId, firm.anchorQuoteId);
    });
  });

  test('rejects invalid parameters, missing JWT, already-expired anchor quotes, and upstream errors', async () => {
    await withSep38Server(async (baseUrl) => {
      await assert.rejects(
        () => sep38Client.getPrices({
          quoteServerUrl: baseUrl,
          sellAsset: 'stellar:native',
          sellAmount: '10',
          buyAmount: '20',
        }),
        { code: 'invalid_parameter', statusCode: 400 },
      );

      await assert.rejects(
        () => sep38Client.getPrice({
          quoteServerUrl: baseUrl,
          sellAsset: 'stellar:native',
          buyAsset: 'iso4217:NGN',
          sellAmount: '10',
          context: 'invalid_context',
        }),
        { code: 'invalid_parameter', statusCode: 400 },
      );

      await assert.rejects(
        () => sep38Client.createFirmQuote({
          quoteServerUrl: baseUrl,
          sellAsset: 'stellar:native',
          buyAsset: 'iso4217:NGN',
          sellAmount: '10',
        }),
        { code: 'missing_sep10_jwt', statusCode: 401 },
      );

      quoteMode = 'already_expired';
      await assert.rejects(
        () => sep38Client.createFirmQuote({
          quoteServerUrl: baseUrl,
          jwt: 'sep10-jwt',
          sellAsset: 'stellar:native',
          buyAsset: 'iso4217:NGN',
          sellAmount: '10',
        }),
        { code: 'sep38_quote_expired', statusCode: 502 },
      );

      quoteMode = 'bad_pair';
      await assert.rejects(
        () => sep38Client.createFirmQuote({
          quoteServerUrl: baseUrl,
          jwt: 'sep10-jwt',
          sellAsset: 'stellar:native',
          buyAsset: 'iso4217:ZZZ',
          sellAmount: '10',
        }),
        { code: 'sep38_anchor_error', statusCode: 400 },
      );
    });
  });
});
