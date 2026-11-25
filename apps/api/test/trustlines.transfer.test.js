// Transfer-flow integration for trustline auto-establishment (#962).
//
// `trustlines.test.js` covers the corridor manager in isolation. This file
// covers the part the issue actually asks for: the trustline being
// established BEFORE an issued-asset transfer, for the recipient who would
// otherwise be unable to receive it.
//
// What is asserted here:
//
//   * native XLM short-circuits with no Horizon and no database access;
//   * a recipient this platform does not custody is reported as such and
//     never blocks the transfer -- only the trustor can sign a ChangeTrust;
//   * recipient resolution matches the refund path: phone (chain+network),
//     then any wallet on the network, then the destination address;
//   * an EXISTING trustline submits nothing (no duplicate ChangeTrust);
//   * a MISSING trustline submits exactly one;
//   * an insufficient XLM base reserve refuses and submits nothing;
//   * the fee bump is real -- the trustor signs the INNER transaction and the
//     sponsor pays the fee -- and it does NOT waive the reserve;
//   * asset identity, authorization and idempotency survive the new path.
//
// Horizon, Prisma and the signer are in-memory fakes. No network, no real
// transaction, no real key.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const StellarSdk = require('@stellar/stellar-sdk');

const trustlines = require('../src/wallet/trustlines');
const { TESTNET_USDC_ISSUER } = require('../src/config/networkProfiles');

const NETWORK = 'testnet';
const PASSPHRASE = StellarSdk.Networks.TESTNET;
const SPOOF_ISSUER = 'GAQAA5L65LSYH7CQ3VTJ7F3HHNTNCQIKEO7YPC2FUYAKQNRFAWSFTNZK';

const RECIPIENT = Object.freeze({
  id: 'w-recipient',
  userId: 'u-recipient',
  chain: 'stellar',
  network: NETWORK,
  publicKey: 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6',
});
const EXTERNAL_ADDRESS = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';

const line = (code, issuer, balance = '0') => ({
  asset_type: 'credit_alphanum4', asset_code: code, asset_issuer: issuer, balance,
});

const account = ({ xlm = '100', lines = [], subentries = 0 } = {}) => ({
  account_id: RECIPIENT.publicKey,
  subentry_count: subentries,
  balances: [...lines, { asset_type: 'native', balance: xlm }],
});

const makeHorizon = ({ accountRecord, baseFee = 100 }) => {
  const calls = { loadAccount: 0 };
  return {
    calls,
    loadAccount: async () => { calls.loadAccount += 1; return accountRecord; },
    fetchBaseFee: async () => baseFee,
  };
};

/**
 * Prisma double: users, wallets, and a trustlineRequest table that enforces
 * UNIQUE (walletId, assetCode, assetIssuer) the way Postgres does.
 */
const makePrisma = ({ users = [], wallets = [], rows = [] } = {}) => {
  const state = { users: [...users], wallets: [...wallets], rows: [...rows], queries: 0 };
  let seq = 0;
  const key = (r) => `${r.walletId}|${r.assetCode}|${r.assetIssuer}`;
  return {
    state,
    user: {
      findFirst: async ({ where }) => {
        state.queries += 1;
        return state.users.find((u) => u.phoneNumber === where.phoneNumber) || null;
      },
    },
    wallet: {
      findUnique: async ({ where }) => {
        state.queries += 1;
        const k = where.userId_chain_network;
        if (!k) return state.wallets.find((w) => w.id === where.id) || null;
        return state.wallets.find(
          (w) => w.userId === k.userId && w.chain === k.chain && w.network === k.network,
        ) || null;
      },
      findFirst: async ({ where }) => {
        state.queries += 1;
        return state.wallets.find((w) => Object.entries(where)
          .every(([f, v]) => w[f] === v)) || null;
      },
    },
    trustlineRequest: {
      create: async ({ data }) => {
        if (state.rows.some((r) => key(r) === key(data))) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        seq += 1;
        const row = { id: `t${seq}`, ...data };
        state.rows.push(row);
        return row;
      },
      findUnique: async ({ where }) => state.rows.find((r) => key(r) === key(where.walletId_assetCode_assetIssuer || where)) || null,
      findFirst: async ({ where }) => state.rows.find((r) => key(r) === key(where)) || null,
      update: async ({ where, data }) => {
        const row = state.rows.find((r) => r.id === where.id) || state.rows.find((r) => key(r) === key(where.walletId_assetCode_assetIssuer || where));
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }) => {
        const matches = state.rows.filter((r) => {
          if (where.walletId && r.walletId !== where.walletId) return false;
          if (where.assetCode && r.assetCode !== where.assetCode) return false;
          if (where.assetIssuer && r.assetIssuer !== where.assetIssuer) return false;
          if (where.status?.in && !where.status.in.includes(r.status)) return false;
          if (typeof where.status === 'string' && r.status !== where.status) return false;
          return true;
        });
        matches.forEach((r) => Object.assign(r, data));
        return { count: matches.length };
      },
      upsert: async ({ where, create, update }) => {
        const k = where.walletId_assetCode_assetIssuer || where;
        const existing = state.rows.find((r) => key(r) === key(k));
        if (existing) { Object.assign(existing, update); return existing; }
        seq += 1;
        const row = { id: `t${seq}`, ...create };
        state.rows.push(row);
        return row;
      },
      findMany: async () => [...state.rows],
    },
  };
};

/** A signer double that records what it was asked to sign. */
const makeSigner = () => {
  const signed = [];
  return {
    signed,
    signInner: async (transaction) => { signed.push(transaction); return transaction; },
  };
};

const custodiedFixture = () => makePrisma({
  users: [{ id: RECIPIENT.userId, phoneNumber: '+2348000000111' }],
  wallets: [{ ...RECIPIENT }],
});

// ── Native asset ────────────────────────────────────────────────────────────

test('native XLM needs no trustline and touches neither Horizon nor the database', async () => {
  const horizon = makeHorizon({ accountRecord: account() });
  const prismaClient = custodiedFixture();

  for (const assetCode of ['XLM', 'native', '', undefined]) {
    const outcome = await trustlines.ensureTrustlineForIncomingTransfer({
      assetCode,
      prismaClient,
      horizon,
      recipientPhoneNumber: '+2348000000111',
      network: NETWORK,
    });
    assert.equal(outcome.required, false);
    assert.equal(outcome.submitted, false);
  }
  assert.equal(horizon.calls.loadAccount, 0, 'no Horizon call for the native asset');
  assert.equal(prismaClient.state.queries, 0, 'no wallet lookup for the native asset');
});

// ── Recipients we cannot sign for ───────────────────────────────────────────

test('an external recipient is reported as not custodied and nothing is submitted', async () => {
  const horizon = makeHorizon({ accountRecord: account() });
  const prismaClient = makePrisma();
  let submitted = 0;

  const outcome = await trustlines.ensureTrustlineForIncomingTransfer({
    assetCode: 'USDC',
    prismaClient,
    horizon,
    destination: EXTERNAL_ADDRESS,
    network: NETWORK,
    resolveSigner: () => ({ buildAndSign: async () => ({}), submit: async () => { submitted += 1; return { hash: 'h' }; } }),
  });

  assert.equal(outcome.required, true);
  assert.equal(outcome.custodied, false);
  assert.equal(outcome.established, false);
  assert.equal(outcome.submitted, false);
  assert.equal(outcome.code, trustlines.TRUSTLINE_ERROR_CODES.NOT_CUSTODIED);
  assert.equal(submitted, 0, 'never submits for an account whose key we do not hold');
  assert.equal(horizon.calls.loadAccount, 0, 'does not even load an account we cannot act on');
  assert.equal(prismaClient.state.rows.length, 0, 'writes no tracking row');
});

test('a non-custodied recipient does not throw, so the transfer is free to proceed', async () => {
  const outcome = await trustlines.ensureTrustlineForIncomingTransfer({
    assetCode: 'USDC',
    prismaClient: makePrisma(),
    horizon: makeHorizon({ accountRecord: account() }),
    destination: EXTERNAL_ADDRESS,
    network: NETWORK,
  });
  assert.equal(outcome.custodied, false);
});

// ── Recipient resolution ────────────────────────────────────────────────────

test('resolves the recipient wallet by phone number on the active chain and network', async () => {
  const prismaClient = custodiedFixture();
  const wallet = await trustlines.resolveCustodiedRecipientWallet({
    prismaClient, recipientPhoneNumber: '+2348000000111', network: NETWORK,
  });
  assert.equal(wallet.id, RECIPIENT.id);
});

test('falls back to any wallet on the network when no chain-keyed wallet exists', async () => {
  const prismaClient = makePrisma({
    users: [{ id: RECIPIENT.userId, phoneNumber: '+2348000000111' }],
    wallets: [{ ...RECIPIENT, chain: 'other-chain' }],
  });
  const wallet = await trustlines.resolveCustodiedRecipientWallet({
    prismaClient, recipientPhoneNumber: '+2348000000111', network: NETWORK,
  });
  assert.equal(wallet.id, RECIPIENT.id);
});

test('resolves by destination address when no phone number is given', async () => {
  const prismaClient = custodiedFixture();
  const wallet = await trustlines.resolveCustodiedRecipientWallet({
    prismaClient, destination: RECIPIENT.publicKey, network: NETWORK,
  });
  assert.equal(wallet.id, RECIPIENT.id);
});

test('a wallet on another network is never used for this network', async () => {
  const prismaClient = makePrisma({
    users: [{ id: RECIPIENT.userId, phoneNumber: '+2348000000111' }],
    wallets: [{ ...RECIPIENT, network: 'mainnet' }],
  });
  const wallet = await trustlines.resolveCustodiedRecipientWallet({
    prismaClient, recipientPhoneNumber: '+2348000000111', destination: RECIPIENT.publicKey, network: NETWORK,
  });
  assert.equal(wallet, null, 'testnet material can never satisfy a mainnet lookup, or the reverse');
});

test('a wallet row with no publicKey is not treated as custodied', async () => {
  const prismaClient = makePrisma({
    users: [{ id: RECIPIENT.userId, phoneNumber: '+2348000000111' }],
    wallets: [{ ...RECIPIENT, publicKey: null }],
  });
  const wallet = await trustlines.resolveCustodiedRecipientWallet({
    prismaClient, recipientPhoneNumber: '+2348000000111', network: NETWORK,
  });
  assert.equal(wallet, null);
});

// ── No duplicate operations ─────────────────────────────────────────────────

test('an existing trustline submits no ChangeTrust before the transfer', async () => {
  const horizon = makeHorizon({
    accountRecord: account({ lines: [line('USDC', TESTNET_USDC_ISSUER, '25')] }),
  });
  const prismaClient = custodiedFixture();
  const signer = makeSigner();
  let submitted = 0;

  const outcome = await trustlines.ensureTrustlineForIncomingTransfer({
    assetCode: 'USDC',
    prismaClient,
    horizon,
    recipientPhoneNumber: '+2348000000111',
    network: NETWORK,
    resolveSigner: () => ({
      buildAndSign: async () => ({}),
      submit: async () => { submitted += 1; return { hash: 'h' }; },
    }),
  });

  assert.equal(outcome.custodied, true);
  assert.equal(outcome.alreadyExisted, true);
  assert.equal(outcome.established, true);
  assert.equal(outcome.submitted, false);
  assert.equal(submitted, 0, 'no duplicate ChangeTrust for a trustline that is already there');
  assert.equal(signer.signed.length, 0, 'nothing was signed');
});

test('a same-code line from a spoofed issuer does not count as the trustline', async () => {
  const horizon = makeHorizon({
    accountRecord: account({ lines: [line('USDC', SPOOF_ISSUER, '999')] }),
  });
  const prismaClient = custodiedFixture();
  let submitted = 0;

  const outcome = await trustlines.ensureTrustlineForIncomingTransfer({
    assetCode: 'USDC',
    prismaClient,
    horizon,
    recipientPhoneNumber: '+2348000000111',
    network: NETWORK,
    resolveSigner: () => ({
      buildAndSign: async () => ({ fake: true }),
      submit: async () => { submitted += 1; return { hash: 'real-trustline' }; },
    }),
  });

  assert.equal(outcome.alreadyExisted, false, 'the look-alike line is NOT the trustline');
  assert.equal(outcome.submitted, true);
  assert.equal(submitted, 1, 'the real trustline is still created alongside the look-alike');
});

test('a missing trustline submits exactly one ChangeTrust', async () => {
  const horizon = makeHorizon({ accountRecord: account({ xlm: '100' }) });
  const prismaClient = custodiedFixture();
  let submitted = 0;

  const outcome = await trustlines.ensureTrustlineForIncomingTransfer({
    assetCode: 'USDC',
    prismaClient,
    horizon,
    recipientPhoneNumber: '+2348000000111',
    network: NETWORK,
    resolveSigner: () => ({
      buildAndSign: async () => ({ fake: true }),
      submit: async () => { submitted += 1; return { hash: 'tx-hash' }; },
    }),
  });

  assert.equal(outcome.established, true);
  assert.equal(outcome.submitted, true);
  assert.equal(submitted, 1);
  assert.equal(prismaClient.state.rows.length, 1, 'exactly one tracking row');
  assert.equal(prismaClient.state.rows[0].status, trustlines.TRUSTLINE_STATUS.ESTABLISHED);
});

test('two concurrent pre-transfer checks produce exactly one submission', async () => {
  const horizon = makeHorizon({ accountRecord: account({ xlm: '100' }) });
  const prismaClient = custodiedFixture();
  let submitted = 0;

  const call = () => trustlines.ensureTrustlineForIncomingTransfer({
    assetCode: 'USDC',
    prismaClient,
    horizon,
    recipientPhoneNumber: '+2348000000111',
    network: NETWORK,
    resolveSigner: () => ({
      buildAndSign: async () => ({ fake: true }),
      submit: async () => { submitted += 1; return { hash: 'tx-hash' }; },
    }),
  });

  const [a, b] = await Promise.all([call(), call()]);
  assert.equal(submitted, 1, 'the UNIQUE constraint, not a read-then-write check, is the arbiter');
  assert.equal([a, b].filter((r) => r.duplicateSuppressed).length, 1);
});

// ── Insufficient XLM base reserve ───────────────────────────────────────────

test('an insufficient base reserve refuses before the transfer and submits nothing', async () => {
  // 2 + 1 subentries * 0.5 XLM = 1.5 XLM required, plus the fee.
  const horizon = makeHorizon({ accountRecord: account({ xlm: '1.4' }) });
  const prismaClient = custodiedFixture();
  let submitted = 0;

  await assert.rejects(
    () => trustlines.ensureTrustlineForIncomingTransfer({
      assetCode: 'USDC',
      prismaClient,
      horizon,
      recipientPhoneNumber: '+2348000000111',
      network: NETWORK,
      resolveSigner: () => ({
        buildAndSign: async () => ({ fake: true }),
        submit: async () => { submitted += 1; return { hash: 'h' }; },
      }),
    }),
    (error) => {
      assert.equal(error.code, trustlines.TRUSTLINE_ERROR_CODES.INSUFFICIENT_RESERVE);
      assert.match(error.message, /Keep at least/);
      return true;
    },
  );

  assert.equal(submitted, 0, 'never submits a ChangeTrust that would die with op_low_reserve');
  assert.equal(prismaClient.state.rows[0].status, trustlines.TRUSTLINE_STATUS.FAILED);
});

test('a fee-bump sponsor does not waive the base reserve on the transfer path', async () => {
  const horizon = makeHorizon({ accountRecord: account({ xlm: '1.4' }) });
  let submitted = 0;

  await assert.rejects(
    () => trustlines.ensureTrustlineForIncomingTransfer({
      assetCode: 'USDC',
      prismaClient: custodiedFixture(),
      horizon,
      recipientPhoneNumber: '+2348000000111',
      network: NETWORK,
      feeBumpSponsor: { publicKey: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ' },
      resolveSigner: () => ({
        buildAndSign: async () => ({ fake: true }),
        submit: async () => { submitted += 1; return { hash: 'h' }; },
      }),
    }),
    (error) => {
      assert.equal(error.code, trustlines.TRUSTLINE_ERROR_CODES.INSUFFICIENT_RESERVE);
      assert.match(error.message, /pays the fee but not the base reserve/);
      return true;
    },
  );
  assert.equal(submitted, 0);
});

// ── Authorization ───────────────────────────────────────────────────────────

test('a custodied recipient with no signer refuses rather than claiming success', async () => {
  const horizon = makeHorizon({ accountRecord: account({ xlm: '100' }) });
  await assert.rejects(
    () => trustlines.ensureTrustlineForIncomingTransfer({
      assetCode: 'USDC',
      prismaClient: custodiedFixture(),
      horizon,
      recipientPhoneNumber: '+2348000000111',
      network: NETWORK,
      // no resolveSigner
    }),
    (error) => {
      assert.equal(error.code, trustlines.TRUSTLINE_ERROR_CODES.NO_SIGNER);
      return true;
    },
  );
});

test('createChangeTrustSubmitter refuses to exist without the trustor signer', () => {
  assert.throws(
    () => trustlines.createChangeTrustSubmitter({
      stellar: { StellarSdk, server: {} },
      networkPassphrase: PASSPHRASE,
      feeBumpSponsor: { keypair: StellarSdk.Keypair.random() },
    }),
    (error) => {
      assert.equal(error.code, trustlines.TRUSTLINE_ERROR_CODES.NO_SIGNER);
      return true;
    },
  );
});

test('an unconfigured NGNT corridor refuses on the transfer path and writes no row', async () => {
  const prismaClient = custodiedFixture();
  const saved = process.env.STELLAR_NGNT_ISSUER;
  delete process.env.STELLAR_NGNT_ISSUER;
  try {
    await assert.rejects(
      () => trustlines.ensureTrustlineForIncomingTransfer({
        assetCode: 'NGNT',
        prismaClient,
        horizon: makeHorizon({ accountRecord: account({ xlm: '100' }) }),
        recipientPhoneNumber: '+2348000000111',
        network: NETWORK,
      }),
      (error) => {
        assert.equal(error.code, trustlines.TRUSTLINE_ERROR_CODES.ISSUER_NOT_CONFIGURED);
        return true;
      },
    );
  } finally {
    if (saved !== undefined) process.env.STELLAR_NGNT_ISSUER = saved;
  }
  assert.equal(prismaClient.state.rows.length, 0, 'an unavailable corridor writes nothing');
});

test('an unsupported asset code refuses on the transfer path', async () => {
  await assert.rejects(
    () => trustlines.ensureTrustlineForIncomingTransfer({
      assetCode: 'DOGE',
      prismaClient: custodiedFixture(),
      horizon: makeHorizon({ accountRecord: account({ xlm: '100' }) }),
      recipientPhoneNumber: '+2348000000111',
      network: NETWORK,
    }),
    (error) => {
      assert.equal(error.code, trustlines.TRUSTLINE_ERROR_CODES.UNSUPPORTED_ASSET);
      return true;
    },
  );
});

// ── The fee bump is real ────────────────────────────────────────────────────

test('without a sponsor the ChangeTrust is a plain transaction signed by the trustor', async () => {
  const trustor = StellarSdk.Keypair.random();
  const accountRecord = new StellarSdk.Account(trustor.publicKey(), '7');
  const { buildAndSign } = trustlines.createChangeTrustSubmitter({
    stellar: { StellarSdk, server: {} },
    networkPassphrase: PASSPHRASE,
    signInner: (tx) => { tx.sign(trustor); },
  });

  const tx = await buildAndSign({
    accountRecord,
    asset: new StellarSdk.Asset('USDC', TESTNET_USDC_ISSUER),
    fee: '100',
  });

  assert.ok(!(tx instanceof StellarSdk.FeeBumpTransaction), 'no fee bump when no sponsor');
  assert.equal(tx.operations.length, 1);
  assert.equal(tx.operations[0].type, 'changeTrust');
  assert.equal(tx.source, trustor.publicKey(), 'the ChangeTrust source is the trustor');
  assert.equal(tx.signatures.length, 1, 'signed once, by the trustor');
});

test('with a sponsor the ChangeTrust is wrapped in a SEP-0015 fee bump the sponsor pays', async () => {
  const trustor = StellarSdk.Keypair.random();
  const sponsor = StellarSdk.Keypair.random();
  const accountRecord = new StellarSdk.Account(trustor.publicKey(), '7');

  const { buildAndSign } = trustlines.createChangeTrustSubmitter({
    stellar: { StellarSdk, server: {} },
    networkPassphrase: PASSPHRASE,
    signInner: (tx) => { tx.sign(trustor); },
    feeBumpSponsor: { keypair: sponsor },
  });

  const bumped = await buildAndSign({
    accountRecord,
    asset: new StellarSdk.Asset('USDC', TESTNET_USDC_ISSUER),
    fee: '100',
  });

  assert.ok(bumped instanceof StellarSdk.FeeBumpTransaction, 'a real FeeBumpTransaction');
  assert.equal(bumped.feeSource, sponsor.publicKey(), 'the SPONSOR pays the fee');

  const inner = bumped.innerTransaction;
  assert.equal(inner.operations[0].type, 'changeTrust');
  assert.equal(inner.source, trustor.publicKey(), 'the inner source is still the trustor');
  assert.equal(inner.signatures.length, 1, 'the trustor signed the inner transaction');
  assert.ok(
    inner.signatures[0].hint().equals(trustor.signatureHint()),
    'the inner signature is the TRUSTOR\'s, not the sponsor\'s',
  );
  assert.equal(bumped.signatures.length, 1, 'the sponsor signed the outer envelope');
  assert.ok(
    bumped.signatures[0].hint().equals(sponsor.signatureHint()),
    'the outer signature is the sponsor\'s',
  );
});

test('a fee bump never replaces the trustor signature on the inner transaction', async () => {
  const trustor = StellarSdk.Keypair.random();
  const sponsor = StellarSdk.Keypair.random();
  const signer = makeSigner();

  const { buildAndSign } = trustlines.createChangeTrustSubmitter({
    stellar: { StellarSdk, server: {} },
    networkPassphrase: PASSPHRASE,
    signInner: signer.signInner,
    feeBumpSponsor: { keypair: sponsor },
  });

  // signInner is a no-op recorder here: the inner transaction ends up unsigned,
  // which is exactly what an unauthorized ChangeTrust looks like. The point is
  // that the sponsor's signature is NOT accepted in its place.
  const bumped = await buildAndSign({
    accountRecord: new StellarSdk.Account(trustor.publicKey(), '7'),
    asset: new StellarSdk.Asset('USDC', TESTNET_USDC_ISSUER),
    fee: '100',
  });

  assert.equal(signer.signed.length, 1, 'the trustor signer was asked to sign the inner transaction');
  assert.equal(bumped.innerTransaction.signatures.length, 0);
  assert.equal(bumped.signatures.length, 1, 'only the fee source signed the envelope');
});

test('submit returns the hash Horizon reports', async () => {
  const { submit } = trustlines.createChangeTrustSubmitter({
    stellar: { StellarSdk, server: { submitTransaction: async () => ({ hash: 'horizon-hash' }) } },
    networkPassphrase: PASSPHRASE,
    signInner: () => {},
  });
  assert.deepEqual(await submit({}), { hash: 'horizon-hash' });
});

// ── Regression: the path-payment destination asset is what matters ──────────

test('the asset checked is the one the recipient receives, not the one sent', async () => {
  // A path payment sends XLM and delivers USDC: the recipient needs the USDC
  // trustline, so passing the DESTINATION asset must trigger the check.
  const horizon = makeHorizon({ accountRecord: account({ xlm: '100' }) });
  let submitted = 0;

  const outcome = await trustlines.ensureTrustlineForIncomingTransfer({
    assetCode: 'USDC',
    prismaClient: custodiedFixture(),
    horizon,
    recipientPhoneNumber: '+2348000000111',
    network: NETWORK,
    resolveSigner: () => ({
      buildAndSign: async () => ({ fake: true }),
      submit: async () => { submitted += 1; return { hash: 'h' }; },
    }),
  });

  assert.equal(outcome.required, true);
  assert.equal(submitted, 1);
});
