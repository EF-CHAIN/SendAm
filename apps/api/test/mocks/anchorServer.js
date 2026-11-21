const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const {
  Account,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} = require('@stellar/stellar-sdk');

const DEFAULT_SERVER_SEED = Buffer.alloc(32, 7);

const base64UrlEncode = (input) => Buffer.from(input)
  .toString('base64')
  .replace(/=/g, '')
  .replace(/\+/g, '-')
  .replace(/\//g, '_');

const base64UrlDecode = (input) => {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
};

const signJwt = (payload, secret) => {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${header}.${body}.${sig}`;
};

const verifyJwt = (token, secret) => {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  if (sig !== expected) return null;
  try {
    return JSON.parse(base64UrlDecode(body));
  } catch (_err) {
    return null;
  }
};

/**
 * Creates a deterministic, in-memory Express mock Stellar Anchor server
 * implementing SEP-10, SEP-24, SEP-31, and SEP-38 for offline testing.
 *
 * @param {object} [options]
 * @param {Keypair} [options.serverKeypair]
 * @param {string} [options.networkPassphrase]
 * @param {string} [options.homeDomain='mock-anchor.sendam.local']
 * @param {string} [options.jwtSecret='mock-anchor-jwt-secret']
 * @param {Record<string, number>} [options.exchangeRates]
 */
const createAnchorMockServer = ({
  serverKeypair = Keypair.fromRawEd25519Seed(DEFAULT_SERVER_SEED),
  networkPassphrase = Networks.TESTNET,
  homeDomain = 'mock-anchor.sendam.local',
  jwtSecret = 'mock-anchor-jwt-secret',
  exchangeRates = {
    'iso4217:NGN->stellar:USDC': 1600,
    'stellar:USDC->iso4217:NGN': 0.000625,
    'iso4217:USD->iso4217:NGN': 0.000625,
  },
} = {}) => {
  let healthy = true;
  let seq = 0;
  const nextId = (prefix) => {
    seq += 1;
    return `${prefix}-${seq}`;
  };

  const state = {
    sep24Transactions: new Map(),
    sep31Transactions: new Map(),
    sep38Quotes: new Map(),
  };

  const reset = () => {
    healthy = true;
    seq = 0;
    state.sep24Transactions.clear();
    state.sep31Transactions.clear();
    state.sep38Quotes.clear();
  };

  const setHealthy = (isHealthy) => {
    healthy = Boolean(isHealthy);
  };

  const app = express();
  app.use(express.json());

  let baseUrl = '';

  const requireAuth = (req, res, next) => {
    const auth = req.headers.authorization || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res.status(401).json({ error: 'Missing bearer token' });
    }
    const claims = verifyJwt(match[1], jwtSecret);
    if (!claims || !claims.sub) {
      return res.status(401).json({ error: 'Invalid bearer token' });
    }
    req.authAccount = claims.sub;
    return next();
  };

  // Discovery: /.well-known/stellar.toml
  app.get('/.well-known/stellar.toml', (_req, res) => {
    res.type('text/plain').send([
      `NETWORK_PASSPHRASE="${networkPassphrase}"`,
      `SIGNING_KEY="${serverKeypair.publicKey()}"`,
      `WEB_AUTH_ENDPOINT="${baseUrl}/auth"`,
      `TRANSFER_SERVER_SEP0024="${baseUrl}/sep24"`,
      `DIRECT_PAYMENT_SERVER="${baseUrl}/sep31"`,
      `ANCHOR_QUOTE_SERVER="${baseUrl}/sep38"`,
    ].join('\n'));
  });

  // Health & capabilities: GET /info
  app.get('/info', (_req, res) => {
    if (!healthy) {
      return res.status(503).json({ error: 'Anchor temporarily unavailable' });
    }
    return res.status(200).json({
      status: 'ok',
      home_domain: homeDomain,
      capabilities: {
        sep10: true,
        sep24: true,
        sep31: true,
        sep38: true,
      },
      assets: ['USDC', 'NGN', 'XLM'],
    });
  });

  // SEP-10: GET /auth (challenge issuance)
  app.get('/auth', (req, res) => {
    const account = typeof req.query.account === 'string' ? req.query.account.trim() : '';
    if (!StrKey.isValidEd25519PublicKey(account)) {
      return res.status(400).json({ error: 'Invalid or missing account parameter' });
    }

    const serverAccount = new Account(serverKeypair.publicKey(), '-1');
    const nonce = Buffer.from(`deterministic-nonce-${seq + 1}`).toString('base64');
    const tx = new TransactionBuilder(serverAccount, {
      fee: '100',
      networkPassphrase,
    })
      .addOperation(Operation.manageData({
        source: account,
        name: `${homeDomain} auth`,
        value: nonce,
      }))
      .setTimeout(300)
      .build();

    tx.sign(serverKeypair);

    return res.status(200).json({
      transaction: tx.toXDR(),
      network_passphrase: networkPassphrase,
    });
  });

  // SEP-10: POST /auth (challenge verification -> JWT)
  app.post('/auth', (req, res) => {
    const xdrStr = req.body && req.body.transaction;
    if (typeof xdrStr !== 'string' || !xdrStr.trim()) {
      return res.status(400).json({ error: 'Missing transaction XDR' });
    }

    let tx;
    try {
      tx = TransactionBuilder.fromXDR(xdrStr, networkPassphrase);
    } catch (_err) {
      return res.status(400).json({ error: 'Invalid transaction XDR' });
    }

    const authOp = tx.operations && tx.operations[0];
    const clientAccount = authOp && authOp.source;
    if (!clientAccount || !StrKey.isValidEd25519PublicKey(clientAccount)) {
      return res.status(400).json({ error: 'Missing client account in challenge' });
    }

    const txHash = tx.hash();
    const clientKeypair = Keypair.fromPublicKey(clientAccount);
    const hasServerSig = tx.signatures.some((sig) => serverKeypair.verify(txHash, sig.signature()));
    const hasClientSig = tx.signatures.some((sig) => clientKeypair.verify(txHash, sig.signature()));

    if (!hasServerSig || !hasClientSig) {
      return res.status(400).json({ error: 'Challenge transaction missing required signatures' });
    }

    const token = signJwt({
      iss: `${baseUrl}/auth`,
      sub: clientAccount,
      iat: 1700000000,
      exp: 1900000000,
    }, jwtSecret);

    return res.status(200).json({ token });
  });

  // SEP-24: GET /sep24/info
  app.get('/sep24/info', (_req, res) => {
    res.status(200).json({
      deposit: {
        USDC: { enabled: true, min_amount: 1, max_amount: 10000 },
        NGN: { enabled: true, min_amount: 100, max_amount: 5000000 },
      },
      withdraw: {
        USDC: { enabled: true, min_amount: 1, max_amount: 10000 },
        NGN: { enabled: true, min_amount: 100, max_amount: 5000000 },
      },
    });
  });

  // SEP-24: Interactive deposit / withdraw
  const handleSep24Interactive = (kind) => (req, res) => {
    const assetCode = req.body && req.body.asset_code;
    if (!assetCode) {
      return res.status(400).json({ error: 'Missing asset_code' });
    }

    const id = nextId(`sep24-${kind}`);
    const tx = {
      id,
      kind,
      status: 'incomplete',
      asset_code: assetCode,
      amount_in: req.body.amount ? String(req.body.amount) : null,
      account: req.authAccount,
      started_at: '2026-01-01T00:00:00.000Z',
    };
    state.sep24Transactions.set(id, tx);

    return res.status(200).json({
      type: 'interactive_customer_info_needed',
      url: `${baseUrl}/sep24/webview/${id}`,
      id,
    });
  };

  app.post('/sep24/transactions/deposit/interactive', requireAuth, handleSep24Interactive('deposit'));
  app.post('/sep24/transactions/withdraw/interactive', requireAuth, handleSep24Interactive('withdrawal'));

  // SEP-24: Webview simulation
  app.get('/sep24/webview/:id', (req, res) => {
    const tx = state.sep24Transactions.get(req.params.id);
    if (!tx) {
      return res.status(404).send('<html><body>Transaction not found</body></html>');
    }
    return res.status(200).type('text/html').send(
      `<html><body><h1>Mock SEP-24 ${tx.kind}</h1><p>ID: ${tx.id}</p><p>Status: ${tx.status}</p></body></html>`,
    );
  });

  app.post('/sep24/webview/:id/complete', (req, res) => {
    const tx = state.sep24Transactions.get(req.params.id);
    if (!tx) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    tx.status = 'completed';
    tx.completed_at = '2026-01-01T00:01:00.000Z';
    return res.status(200).json({ transaction: tx });
  });

  app.get('/sep24/transaction', requireAuth, (req, res) => {
    const tx = state.sep24Transactions.get(req.query.id);
    if (!tx || tx.account !== req.authAccount) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    return res.status(200).json({ transaction: tx });
  });

  app.get('/sep24/transactions', requireAuth, (req, res) => {
    const transactions = [...state.sep24Transactions.values()].filter((t) => t.account === req.authAccount);
    return res.status(200).json({ transactions });
  });

  // SEP-31: Cross-border remittance
  app.get('/sep31/info', (_req, res) => {
    res.status(200).json({
      receive: {
        USDC: {
          enabled: true,
          quotes_supported: true,
          quotes_required: false,
          min_amount: 1,
          max_amount: 10000,
        },
        NGN: {
          enabled: true,
          quotes_supported: true,
          quotes_required: false,
          min_amount: 100,
          max_amount: 5000000,
        },
      },
    });
  });

  app.post('/sep31/transactions', requireAuth, (req, res) => {
    const { amount, asset_code: assetCode, quote_id: quoteId } = req.body || {};
    if (!amount || !assetCode) {
      return res.status(400).json({ error: 'Missing required amount or asset_code' });
    }
    if (quoteId && !state.sep38Quotes.has(quoteId)) {
      return res.status(400).json({ error: 'Referenced quote_id not found' });
    }

    const id = nextId('sep31');
    const memo = `memo-${id}`;
    const tx = {
      id,
      status: 'pending_sender',
      amount_in: String(amount),
      amount_in_asset: assetCode,
      quote_id: quoteId || null,
      stellar_account_id: serverKeypair.publicKey(),
      stellar_memo_type: 'text',
      stellar_memo: memo,
      account: req.authAccount,
    };
    state.sep31Transactions.set(id, tx);

    return res.status(201).json({
      id: tx.id,
      stellar_account_id: tx.stellar_account_id,
      stellar_memo_type: tx.stellar_memo_type,
      stellar_memo: tx.stellar_memo,
    });
  });

  app.get('/sep31/transactions/:id', requireAuth, (req, res) => {
    const tx = state.sep31Transactions.get(req.params.id);
    if (!tx || tx.account !== req.authAccount) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    return res.status(200).json({ transaction: tx });
  });

  // SEP-38: Anchor RFQ (Quotes)
  app.get('/sep38/info', (_req, res) => {
    res.status(200).json({
      assets: [
        { asset: 'stellar:USDC' },
        { asset: 'iso4217:NGN', country_codes: ['NGA'] },
        { asset: 'iso4217:USD', country_codes: ['USA'] },
      ],
    });
  });

  const computeQuote = (sellAsset, buyAsset, sellAmount) => {
    const key = `${sellAsset}->${buyAsset}`;
    const rate = exchangeRates[key] || 1;
    const sellNum = Number(sellAmount);
    const buyNum = sellNum / rate;
    return {
      price: String(rate),
      sell_asset: sellAsset,
      sell_amount: sellNum.toFixed(2),
      buy_asset: buyAsset,
      buy_amount: buyNum.toFixed(2),
      fee: { total: '0.00', asset: sellAsset },
    };
  };

  app.get('/sep38/price', (req, res) => {
    const { sell_asset: sellAsset, buy_asset: buyAsset, sell_amount: sellAmount } = req.query;
    if (!sellAsset || !buyAsset || !sellAmount) {
      return res.status(400).json({ error: 'Missing sell_asset, buy_asset, or sell_amount' });
    }
    return res.status(200).json(computeQuote(sellAsset, buyAsset, sellAmount));
  });

  app.post('/sep38/quote', requireAuth, (req, res) => {
    const { sell_asset: sellAsset, buy_asset: buyAsset, sell_amount: sellAmount } = req.body || {};
    if (!sellAsset || !buyAsset || !sellAmount) {
      return res.status(400).json({ error: 'Missing sell_asset, buy_asset, or sell_amount' });
    }
    const id = nextId('quote');
    const quote = {
      id,
      expires_at: '2030-01-01T00:00:00.000Z',
      ...computeQuote(sellAsset, buyAsset, sellAmount),
      account: req.authAccount,
    };
    state.sep38Quotes.set(id, quote);
    return res.status(201).json(quote);
  });

  app.get('/sep38/quote/:id', requireAuth, (req, res) => {
    const quote = state.sep38Quotes.get(req.params.id);
    if (!quote || quote.account !== req.authAccount) {
      return res.status(404).json({ error: 'Quote not found' });
    }
    return res.status(200).json(quote);
  });

  let server = null;

  const start = async (port = 0) => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    return baseUrl;
  };

  const stop = async () => {
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
    server = null;
    baseUrl = '';
  };

  return {
    app,
    serverKeypair,
    networkPassphrase,
    homeDomain,
    start,
    stop,
    reset,
    setHealthy,
    getState: () => state,
    getBaseUrl: () => baseUrl,
  };
};

module.exports = {
  createAnchorMockServer,
};
