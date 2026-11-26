// Trustline auto-establishment tests for the USDC / EURC / NGNT corridors (#962).
//
// The guarantees under test:
//
//   * a trustline is identified by (code, issuer), so a same-code line from a
//     spoofed issuer is NOT an established trustline;
//   * an unsupported code, or a code with no configured issuer on this
//     network, refuses cleanly and submits nothing;
//   * the XLM base-reserve arithmetic is exact (BigInt stroops) and is
//     checked at the boundary, one stroop either side;
//   * a fee-bump sponsor does NOT waive the reserve requirement;
//   * no signer means no claim of success;
//   * two concurrent callers produce exactly ONE ChangeTrust submission;
//   * an uncertain submission (timeout) is left pending for reconciliation,
//     never marked failed and never blindly resubmitted.
//
// Horizon and Prisma are in-memory fakes. Nothing touches the network and no
// transaction is ever really submitted.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const trustlines = require('../src/wallet/trustlines');
const { TESTNET_USDC_ISSUER, TESTNET_EURC_ISSUER } = require('../src/config/networkProfiles');
const { formatUnits, STELLAR_PRECISION } = require('../src/utils/money');

const SPOOF_ISSUER = 'GAQAA5L65LSYH7CQ3VTJ7F3HHNTNCQIKEO7YPC2FUYAKQNRFAWSFTNZK';
const WALLET = Object.freeze({ id: 'w1', publicKey: 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6' });

/** Build a Horizon account record. */
const account = ({ xlm = '100', lines = [], subentries = 0 } = {}) => ({
  account_id: WALLET.publicKey,
  subentry_count: subentries,
  balances: [
    ...lines,
    { asset_type: 'native', balance: xlm },
  ],
});

const line = (code, issuer, balance = '0') => ({
  asset_type: 'credit_alphanum4', asset_code: code, asset_issuer: issuer, balance,
});

/** Horizon double. */
const makeHorizon = ({ accountRecord, baseFee = 100, loadError = null }) => ({
  loadAccount: async () => {
    if (loadError) throw loadError;
    return accountRecord;
  },
  fetchBaseFee: async () => baseFee,
});

/** Prisma double enforcing the UNIQUE (walletId, assetCode, assetIssuer). */
const makePrisma = ({ rows = [] } = {}) => {
  const state = { rows: [...rows], wallets: [{ ...WALLET }] };
  let seq = 0;
  const key = (r) => `${r.walletId}|${r.assetCode}|${r.assetIssuer}`;

  const client = {
    state,
    wallet: {
      findUnique: async ({ where }) => state.wallets.find((w) => w.id === where.id) || null,
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
      findUnique: async ({ where }) => {
        const k = where.walletId_assetCode_assetIssuer;
        return state.rows.find((r) => key(r) === key(k)) || null;
      },
      findMany: async ({ where = {} }) => state.rows.filter((r) => (
        (where.status === undefined || r.status === where.status)
        && (where.network === undefined || r.network === where.network)
      )),
      update: async ({ where, data }) => {
        const row = state.rows.find((r) => r.id === where.id);
        Object.assign(row, data);
        return row;
      },
      upsert: async ({ where, create, update }) => {
        const k = where.walletId_assetCode_assetIssuer;
        const found = state.rows.find((r) => key(r) === key(k));
        if (found) { Object.assign(found, update); return found; }
        seq += 1;
        const row = { id: `t${seq}`, ...create };
        state.rows.push(row);
        return row;
      },
    },
  };
  return client;
};

/** A submit spy plus a trivial signer. */
const makeSubmitter = ({ fail = null } = {}) => {
  const calls = [];
  return {
    calls,
    buildAndSign: async ({ asset }) => ({ asset, signed: true }),
    submit: async (tx) => {
      calls.push(tx);
      if (fail) throw fail;
      return { hash: `hash${calls.length}` };
    },
  };
};

// ── Corridor resolution ───────────────────────────────────────────────────

test('all three corridors are declared', () => {
  assert.deepEqual(
    Object.keys(trustlines.SUPPORTED_CORRIDORS).sort(),
    ['EURC', 'NGNT', 'USDC'],
  );
});

test('USDC and EURC resolve to their configured testnet issuers', () => {
  const usdc = trustlines.resolveCorridorAsset({ code: 'USDC', network: 'testnet' });
  assert.equal(usdc.issuer, TESTNET_USDC_ISSUER);
  assert.equal(usdc.assetId, `stellar:testnet:USDC:${TESTNET_USDC_ISSUER}`);

  const eurc = trustlines.resolveCorridorAsset({ code: 'EURC', network: 'testnet' });
  assert.equal(eurc.issuer, TESTNET_EURC_ISSUER);
  assert.notEqual(eurc.issuer, usdc.issuer);
});

test('an unsupported asset code is refused', () => {
  for (const code of ['DOGE', 'XLM', '', null]) {
    assert.throws(
      () => trustlines.resolveCorridorAsset({ code, network: 'testnet' }),
      (e) => e.code === trustlines.TRUSTLINE_ERROR_CODES.UNSUPPORTED_ASSET,
      `${String(code)} must be refused`,
    );
  }
});

test('NGNT is declared but unavailable until an operator configures an issuer', () => {
  // Shipping an unverified issuer would route funds to a worthless same-code
  // token, so the corridor is intentionally inert by default.
  assert.throws(
    () => trustlines.resolveCorridorAsset({ code: 'NGNT', network: 'testnet' }),
    (e) => e.code === trustlines.TRUSTLINE_ERROR_CODES.ISSUER_NOT_CONFIGURED,
  );

  const availability = trustlines.corridorAvailability('testnet');
  const ngnt = availability.find((c) => c.code === 'NGNT');
  assert.equal(ngnt.available, false);
  assert.equal(ngnt.issuer, null);
  assert.equal(ngnt.reason, trustlines.TRUSTLINE_ERROR_CODES.ISSUER_NOT_CONFIGURED);

  // The verified corridors are available.
  assert.equal(availability.find((c) => c.code === 'USDC').available, true);
  assert.equal(availability.find((c) => c.code === 'EURC').available, true);
});

test('a caller naming the right code but the WRONG issuer is refused, not corrected', () => {
  assert.throws(
    () => trustlines.resolveCorridorAsset({
      code: 'USDC', network: 'testnet', expectedIssuer: SPOOF_ISSUER,
    }),
    (e) => e.code === trustlines.TRUSTLINE_ERROR_CODES.ISSUER_MISMATCH,
  );
});

// ── Identity-matched trustline detection ─────────────────────────────────

test('hasTrustline matches on code AND issuer', () => {
  const rec = account({ lines: [line('USDC', TESTNET_USDC_ISSUER)] });
  assert.equal(trustlines.hasTrustline({
    accountRecord: rec, code: 'USDC', issuer: TESTNET_USDC_ISSUER,
  }), true);
});

test('a same-code line from a SPOOFED issuer is NOT an established trustline', () => {
  // The central asset-identity guarantee: holding a worthless look-alike is
  // not the same as being able to receive the real asset.
  const rec = account({ lines: [line('USDC', SPOOF_ISSUER)] });
  assert.equal(trustlines.hasTrustline({
    accountRecord: rec, code: 'USDC', issuer: TESTNET_USDC_ISSUER,
  }), false);
});

test('the native balance is never mistaken for a trustline', () => {
  assert.equal(trustlines.hasTrustline({
    accountRecord: account(), code: 'USDC', issuer: TESTNET_USDC_ISSUER,
  }), false);
});

// ── Reserve arithmetic ───────────────────────────────────────────────────

test('reserve requirement is exact BigInt stroop arithmetic', () => {
  // minimum = (2 + subentries) * baseReserve, plus the fee.
  // 0 existing subentries + 1 new = 3 * 0.5 XLM = 1.5 XLM, + 100 stroops fee.
  const r = trustlines.trustlineReserveRequirement({
    accountRecord: account({ xlm: '10', subentries: 0 }),
  });
  assert.equal(r.required, 15_000_000n + 100n);
  assert.equal(r.balance, 100_000_000n);
  assert.equal(r.sufficient, true);
  assert.equal(r.requiredXlm, '1.5000100');
});

test('each existing subentry raises the requirement by one base reserve', () => {
  const none = trustlines.trustlineReserveRequirement({
    accountRecord: account({ subentries: 0 }),
  });
  const three = trustlines.trustlineReserveRequirement({
    accountRecord: account({ subentries: 3 }),
  });
  assert.equal(three.required - none.required, 3n * trustlines.DEFAULT_BASE_RESERVE_STROOPS);
});

test('BOUNDARY: exactly enough passes; one stroop short fails', () => {
  const required = 15_000_000n + 100n; // 1.5 XLM + 100 stroop fee

  const exact = trustlines.trustlineReserveRequirement({
    accountRecord: account({
      xlm: formatUnits(required, STELLAR_PRECISION),
    }),
  });
  assert.equal(exact.sufficient, true, 'exactly the requirement must be enough');
  assert.equal(exact.available, 0n);

  const short = trustlines.trustlineReserveRequirement({
    accountRecord: account({
      xlm: formatUnits(required - 1n, STELLAR_PRECISION),
    }),
  });
  assert.equal(short.sufficient, false, 'one stroop short must fail');
  assert.equal(short.shortfall, 1n);
});

test('an unfunded or zero-balance account cannot afford a trustline', () => {
  const r = trustlines.trustlineReserveRequirement({ accountRecord: account({ xlm: '0' }) });
  assert.equal(r.sufficient, false);
  assert.equal(r.balance, 0n);
});

// ── ensureTrustline: the happy paths ─────────────────────────────────────

test('an EXISTING trustline is a no-op success with no submission', async () => {
  const prismaClient = makePrisma();
  const s = makeSubmitter();
  const result = await trustlines.ensureTrustline({
    wallet: WALLET,
    assetCode: 'USDC',
    horizon: makeHorizon({ accountRecord: account({ lines: [line('USDC', TESTNET_USDC_ISSUER)] }) }),
    prismaClient,
    buildAndSign: s.buildAndSign,
    submit: s.submit,
    network: 'testnet',
  });

  assert.equal(result.established, true);
  assert.equal(result.alreadyExisted, true);
  assert.equal(result.submitted, false);
  assert.equal(s.calls.length, 0, 'nothing may be submitted');
  assert.equal(prismaClient.state.rows[0].status, trustlines.TRUSTLINE_STATUS.ESTABLISHED);
});

test('a MISSING trustline submits exactly one ChangeTrust and records it', async () => {
  const prismaClient = makePrisma();
  const s = makeSubmitter();
  const result = await trustlines.ensureTrustline({
    wallet: WALLET,
    assetCode: 'EURC',
    horizon: makeHorizon({ accountRecord: account({ xlm: '100' }) }),
    prismaClient,
    buildAndSign: s.buildAndSign,
    submit: s.submit,
    network: 'testnet',
  });

  assert.equal(result.established, true);
  assert.equal(result.submitted, true);
  assert.equal(result.txHash, 'hash1');
  assert.equal(s.calls.length, 1);

  const row = prismaClient.state.rows[0];
  assert.equal(row.assetCode, 'EURC');
  assert.equal(row.assetIssuer, TESTNET_EURC_ISSUER);
  assert.equal(row.status, trustlines.TRUSTLINE_STATUS.ESTABLISHED);
});

test('a spoofed same-code line does not stop the REAL trustline being created', async () => {
  const prismaClient = makePrisma();
  const s = makeSubmitter();
  const result = await trustlines.ensureTrustline({
    wallet: WALLET,
    assetCode: 'USDC',
    horizon: makeHorizon({ accountRecord: account({ lines: [line('USDC', SPOOF_ISSUER)] }) }),
    prismaClient,
    buildAndSign: s.buildAndSign,
    submit: s.submit,
    network: 'testnet',
  });

  assert.equal(result.submitted, true, 'the real issuer still needs its own trustline');
  assert.equal(prismaClient.state.rows[0].assetIssuer, TESTNET_USDC_ISSUER);
});

// ── ensureTrustline: refusals ────────────────────────────────────────────

test('ACCEPTANCE: insufficient XLM reserve is handled gracefully, nothing submitted', async () => {
  const prismaClient = makePrisma();
  const s = makeSubmitter();

  await assert.rejects(
    () => trustlines.ensureTrustline({
      wallet: WALLET,
      assetCode: 'USDC',
      horizon: makeHorizon({ accountRecord: account({ xlm: '0.5' }) }),
      prismaClient,
      buildAndSign: s.buildAndSign,
      submit: s.submit,
      network: 'testnet',
    }),
    (err) => {
      assert.equal(err.code, trustlines.TRUSTLINE_ERROR_CODES.INSUFFICIENT_RESERVE);
      // Actionable: says how much is needed and how much is held.
      assert.match(err.message, /Keep at least/);
      assert.ok(err.required);
      assert.ok(err.balance);
      return true;
    },
  );

  assert.equal(s.calls.length, 0, 'a doomed ChangeTrust must not be submitted');
  assert.equal(prismaClient.state.rows[0].status, trustlines.TRUSTLINE_STATUS.FAILED);
});

test('a FEE BUMP sponsor does NOT waive the base reserve', async () => {
  // A fee bump pays the fee, not the subentry reserve. Only sponsored
  // reserves would, and that is not implemented.
  const prismaClient = makePrisma();
  const s = makeSubmitter();

  await assert.rejects(
    () => trustlines.ensureTrustline({
      wallet: WALLET,
      assetCode: 'USDC',
      horizon: makeHorizon({ accountRecord: account({ xlm: '0.5' }) }),
      prismaClient,
      buildAndSign: s.buildAndSign,
      submit: s.submit,
      network: 'testnet',
      feeBumpSponsor: { publicKey: SPOOF_ISSUER, pays: 'fees' },
    }),
    (err) => {
      assert.equal(err.code, trustlines.TRUSTLINE_ERROR_CODES.INSUFFICIENT_RESERVE);
      assert.match(err.message, /fee-bump sponsor pays the fee but not the base reserve/);
      return true;
    },
  );
  assert.equal(s.calls.length, 0);
});

test('NO SIGNER means refusal, not a false claim of success', async () => {
  const prismaClient = makePrisma();
  await assert.rejects(
    () => trustlines.ensureTrustline({
      wallet: WALLET,
      assetCode: 'USDC',
      horizon: makeHorizon({ accountRecord: account({ xlm: '100' }) }),
      prismaClient,
      buildAndSign: undefined, // nothing can authorize the trustor
      submit: async () => { throw new Error('must not be reached'); },
      network: 'testnet',
    }),
    (e) => e.code === trustlines.TRUSTLINE_ERROR_CODES.NO_SIGNER,
  );
});

test('an unfunded account refuses with a clear reason', async () => {
  const prismaClient = makePrisma();
  const s = makeSubmitter();
  await assert.rejects(
    () => trustlines.ensureTrustline({
      wallet: WALLET,
      assetCode: 'USDC',
      horizon: makeHorizon({ loadError: Object.assign(new Error('Not Found'), { status: 404 }) }),
      prismaClient,
      buildAndSign: s.buildAndSign,
      submit: s.submit,
      network: 'testnet',
    }),
    (e) => e.code === trustlines.TRUSTLINE_ERROR_CODES.ACCOUNT_NOT_FUNDED,
  );
  assert.equal(s.calls.length, 0);
});

test('an unconfigured corridor submits nothing and writes no row', async () => {
  const prismaClient = makePrisma();
  const s = makeSubmitter();
  await assert.rejects(
    () => trustlines.ensureTrustline({
      wallet: WALLET,
      assetCode: 'NGNT',
      horizon: makeHorizon({ accountRecord: account({ xlm: '100' }) }),
      prismaClient,
      buildAndSign: s.buildAndSign,
      submit: s.submit,
      network: 'testnet',
    }),
    (e) => e.code === trustlines.TRUSTLINE_ERROR_CODES.ISSUER_NOT_CONFIGURED,
  );
  assert.equal(s.calls.length, 0);
  assert.equal(prismaClient.state.rows.length, 0, 'no tracking row for an impossible corridor');
});

// ── Duplicate suppression ────────────────────────────────────────────────

test('two CONCURRENT callers produce exactly ONE ChangeTrust submission', async () => {
  const prismaClient = makePrisma();
  const s = makeSubmitter();
  const args = {
    wallet: WALLET,
    assetCode: 'USDC',
    horizon: makeHorizon({ accountRecord: account({ xlm: '100' }) }),
    prismaClient,
    buildAndSign: s.buildAndSign,
    submit: s.submit,
    network: 'testnet',
  };

  const results = await Promise.allSettled([
    trustlines.ensureTrustline({ ...args }),
    trustlines.ensureTrustline({ ...args }),
  ]);

  assert.equal(s.calls.length, 1, 'exactly one ChangeTrust may reach the network');
  assert.equal(prismaClient.state.rows.length, 1, 'one tracking row');

  const suppressed = results
    .filter((r) => r.status === 'fulfilled')
    .find((r) => r.value.duplicateSuppressed);
  assert.ok(suppressed, 'the losing caller reports duplicate suppression');
});

test('a FAILED request may be retried, and the attempt count rises', async () => {
  const prismaClient = makePrisma({
    rows: [{
      id: 't1',
      walletId: WALLET.id,
      assetCode: 'USDC',
      assetIssuer: TESTNET_USDC_ISSUER,
      network: 'testnet',
      status: trustlines.TRUSTLINE_STATUS.FAILED,
      attempts: 1,
      lastError: 'op_low_reserve',
    }],
  });
  const s = makeSubmitter();

  const result = await trustlines.ensureTrustline({
    wallet: WALLET,
    assetCode: 'USDC',
    horizon: makeHorizon({ accountRecord: account({ xlm: '100' }) }),
    prismaClient,
    buildAndSign: s.buildAndSign,
    submit: s.submit,
    network: 'testnet',
  });

  assert.equal(result.established, true);
  assert.equal(s.calls.length, 1);
  assert.equal(prismaClient.state.rows[0].attempts, 2);
});

// ── Submission outcomes ──────────────────────────────────────────────────

test('a DEFINITIVE failure is recorded as failed with its result codes', async () => {
  const prismaClient = makePrisma();
  const horizonError = Object.assign(new Error('Transaction failed'), {
    response: {
      status: 400,
      data: { extras: { result_codes: { transaction: 'tx_failed', operations: ['op_low_reserve'] } } },
    },
  });
  const s = makeSubmitter({ fail: horizonError });

  await assert.rejects(
    () => trustlines.ensureTrustline({
      wallet: WALLET,
      assetCode: 'USDC',
      horizon: makeHorizon({ accountRecord: account({ xlm: '100' }) }),
      prismaClient,
      buildAndSign: s.buildAndSign,
      submit: s.submit,
      network: 'testnet',
    }),
    (e) => e.code === trustlines.TRUSTLINE_ERROR_CODES.SUBMISSION_FAILED,
  );

  const row = prismaClient.state.rows[0];
  assert.equal(row.status, trustlines.TRUSTLINE_STATUS.FAILED);
  assert.match(row.lastError, /op_low_reserve/);
});

test('an UNCERTAIN submission is left pending, never marked failed', async () => {
  // A 504 means we never learned the outcome: the ChangeTrust may be in the
  // ledger. Calling that "failed" and retrying risks a duplicate operation.
  const prismaClient = makePrisma();
  const timeout = Object.assign(new Error('timeout of 10000ms exceeded'), {
    response: { status: 504 },
  });
  const s = makeSubmitter({ fail: timeout });

  const result = await trustlines.ensureTrustline({
    wallet: WALLET,
    assetCode: 'USDC',
    horizon: makeHorizon({ accountRecord: account({ xlm: '100' }) }),
    prismaClient,
    buildAndSign: s.buildAndSign,
    submit: s.submit,
    network: 'testnet',
  });

  assert.equal(result.established, false, 'we must not claim success we did not confirm');
  assert.equal(result.pending, true);
  assert.equal(result.reason, trustlines.TRUSTLINE_ERROR_CODES.SUBMISSION_UNCERTAIN);
  assert.equal(
    prismaClient.state.rows[0].status, trustlines.TRUSTLINE_STATUS.SUBMITTED,
    'pending, not failed',
  );
});

test('uncertainty classification distinguishes timeouts from result-code failures', () => {
  assert.equal(trustlines.isSubmissionUncertain(
    Object.assign(new Error('x'), { response: { status: 504 } }),
  ), true);
  assert.equal(trustlines.isSubmissionUncertain(new Error('socket hang up')), true);
  assert.equal(trustlines.isSubmissionUncertain(
    Object.assign(new Error('x'), {
      response: { status: 400, data: { extras: { result_codes: { transaction: 'tx_bad_auth' } } } },
    }),
  ), false);
});

test('a pending request is NOT resubmitted while in flight', async () => {
  const prismaClient = makePrisma({
    rows: [{
      id: 't1',
      walletId: WALLET.id,
      assetCode: 'USDC',
      assetIssuer: TESTNET_USDC_ISSUER,
      network: 'testnet',
      status: trustlines.TRUSTLINE_STATUS.SUBMITTED,
      attempts: 1,
    }],
  });
  const s = makeSubmitter();

  const result = await trustlines.ensureTrustline({
    wallet: WALLET,
    assetCode: 'USDC',
    horizon: makeHorizon({ accountRecord: account({ xlm: '100' }) }),
    prismaClient,
    buildAndSign: s.buildAndSign,
    submit: s.submit,
    network: 'testnet',
  });

  assert.equal(result.duplicateSuppressed, true);
  assert.equal(s.calls.length, 0, 'an in-flight ChangeTrust is never duplicated');
});

// ── Reconciliation ───────────────────────────────────────────────────────

test('reconciliation confirms an uncertain submission by re-reading the ledger', async () => {
  const prismaClient = makePrisma({
    rows: [{
      id: 't1',
      walletId: WALLET.id,
      assetCode: 'USDC',
      assetIssuer: TESTNET_USDC_ISSUER,
      network: 'testnet',
      status: trustlines.TRUSTLINE_STATUS.SUBMITTED,
      attempts: 1,
    }],
  });

  // The trustline did in fact land.
  const summary = await trustlines.reconcilePendingTrustlines({
    prismaClient,
    horizon: makeHorizon({
      accountRecord: account({ lines: [line('USDC', TESTNET_USDC_ISSUER)] }),
    }),
    network: 'testnet',
  });

  assert.equal(summary.checked, 1);
  assert.equal(summary.established, 1);
  assert.equal(prismaClient.state.rows[0].status, trustlines.TRUSTLINE_STATUS.ESTABLISHED);
});

test('reconciliation leaves a genuinely absent trustline pending', async () => {
  const prismaClient = makePrisma({
    rows: [{
      id: 't1',
      walletId: WALLET.id,
      assetCode: 'USDC',
      assetIssuer: TESTNET_USDC_ISSUER,
      network: 'testnet',
      status: trustlines.TRUSTLINE_STATUS.SUBMITTED,
      attempts: 1,
    }],
  });

  const summary = await trustlines.reconcilePendingTrustlines({
    prismaClient,
    horizon: makeHorizon({ accountRecord: account({ xlm: '100' }) }),
    network: 'testnet',
  });

  assert.equal(summary.established, 0);
  assert.equal(summary.stillPending, 1);
  assert.equal(prismaClient.state.rows[0].status, trustlines.TRUSTLINE_STATUS.SUBMITTED);
});

// ── Transfer-flow hook ───────────────────────────────────────────────────

test('native XLM needs no trustline and triggers no Horizon call', async () => {
  for (const code of ['XLM', 'native', 'xlm']) {
    const result = await trustlines.ensureTrustlineForTransfer({
      assetCode: code,
      wallet: WALLET,
      horizon: { loadAccount: async () => { throw new Error('must not be called'); } },
      prismaClient: makePrisma(),
    });
    assert.equal(result.required, false);
    assert.equal(result.established, true);
  }
});

test('an issued asset routes through the full trustline check before transfer', async () => {
  const prismaClient = makePrisma();
  const s = makeSubmitter();
  const result = await trustlines.ensureTrustlineForTransfer({
    assetCode: 'usdc', // case-insensitive
    wallet: WALLET,
    horizon: makeHorizon({ accountRecord: account({ xlm: '100' }) }),
    prismaClient,
    buildAndSign: s.buildAndSign,
    submit: s.submit,
    network: 'testnet',
  });

  assert.equal(result.required, true);
  assert.equal(result.established, true);
  assert.equal(s.calls.length, 1);
});

test('a transfer is blocked when the trustline cannot be established', async () => {
  // The transfer flow must not proceed believing the recipient can receive.
  const prismaClient = makePrisma();
  const s = makeSubmitter();
  await assert.rejects(
    () => trustlines.ensureTrustlineForTransfer({
      assetCode: 'USDC',
      wallet: WALLET,
      horizon: makeHorizon({ accountRecord: account({ xlm: '0.1' }) }),
      prismaClient,
      buildAndSign: s.buildAndSign,
      submit: s.submit,
      network: 'testnet',
    }),
    (e) => e.code === trustlines.TRUSTLINE_ERROR_CODES.INSUFFICIENT_RESERVE,
  );
  assert.equal(s.calls.length, 0);
});
