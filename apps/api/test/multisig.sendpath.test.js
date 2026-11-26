'use strict';

// #959: the quorum policy wired into the one place a transaction can reach
// Horizon.
//
// These are the tests `multisig.test.js` could not write, because they are
// about the WIRING rather than the policy:
//
//   * a low-value transfer still submits with ONE key — including when the
//     co-signer configuration is actively broken, which proves the co-signer
//     path is never even resolved below the threshold;
//   * a high-value transfer does not reach `server.submitTransaction` unless
//     the envelope carries two valid signatures;
//   * every way of failing to obtain that second signature is refused, with a
//     stable code, before any transport exists;
//   * a retry that rebuilds the envelope is gated again — a retry is not a
//     hole;
//   * no other module under `src/` can reach Horizon with a payment.
//
// Everything is offline: Horizon is mocked, every keypair is generated at
// runtime, and no secret is ever committed.

const { test, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.MULTISIG_HIGH_VALUE_THRESHOLD = '1000';

const stellarAdapter = require('../src/wallet/stellar.adapter');
const multisig = require('../src/wallet/multisig');
const { server, StellarSdk } = require('../src/config/stellar');

const THRESHOLD = '1000';
const TESTNET = StellarSdk.Networks.TESTNET;

// Throwaway quorum members, generated per run.
const custody = StellarSdk.Keypair.random();
const compliance = StellarSdk.Keypair.random();
const operator = StellarSdk.Keypair.random();
const outsider = StellarSdk.Keypair.random();
const DESTINATION = StellarSdk.Keypair.random().publicKey();

const DEFAULT_SIGNERS = [
  { key: custody.publicKey(), weight: 1, type: 'ed25519_public_key' },
  { key: compliance.publicKey(), weight: 1, type: 'ed25519_public_key' },
  { key: operator.publicKey(), weight: 1, type: 'ed25519_public_key' },
];

/**
 * An `AccountResponse`-shaped record: the base `Account` the builder needs
 * plus the Horizon fields the policy reads (`signers`, `thresholds`).
 *
 * `signers: null` deliberately means "no signers array at all", which the
 * policy must refuse rather than assume open.
 */
const horizonAccount = ({ signers, thresholds, balance = '100000' } = {}) => {
  const account = new StellarSdk.Account(custody.publicKey(), '1');
  account.balances = [{ asset_type: 'native', balance, selling_liabilities: '0' }];
  account.subentry_count = 0;
  account.signers = signers === undefined ? DEFAULT_SIGNERS : signers;
  account.thresholds = thresholds === undefined
    ? { low_threshold: 1, med_threshold: 1, high_threshold: 2 }
    : thresholds;
  return account;
};

const asRecord = (account) => ({
  account_id: custody.publicKey(),
  signers: account.signers,
  thresholds: account.thresholds,
});

let submitCalls;
let lastSubmitted;

const setUpHorizon = ({ account, submitTransaction } = {}) => {
  submitCalls = 0;
  lastSubmitted = null;
  mock.method(server, 'ledgers', () => ({
    order: () => ({ limit: () => ({ call: async () => ({ records: [{ base_reserve_in_stroops: 5_000_000 }] }) }) }),
  }));
  mock.method(server, 'fetchBaseFee', async () => '100');
  mock.method(server, 'loadAccount', async () => account || horizonAccount());
  mock.method(server, 'submitTransaction', submitTransaction || (async (transaction) => {
    submitCalls += 1;
    lastSubmitted = transaction;
    return { hash: 'mock-hash', successful: true, ledger: 1 };
  }));
};

/** A Horizon lookup that finds nothing, so a tx_bad_seq retry really rebuilds. */
const horizonLookupFindsNothing = () => {
  mock.method(server, 'transactions', () => ({
    transactionHash: () => ({ call: async () => { throw new Error('not found'); } }),
  }));
};

const coSignerFrom = (keypair, impl) => ({
  keyId: `quorum-${keypair.publicKey().slice(0, 6)}`,
  publicKey: keypair.publicKey(),
  signHash: impl || (async ({ hash }) => keypair.sign(hash)),
});

const pay = ({ amount, signer, onEnvelope } = {}) => stellarAdapter.submitPayment({
  ...(signer ? { signer } : { secretKey: custody.secret() }),
  destination: DESTINATION,
  amount,
  asset: 'XLM',
  ...(onEnvelope ? { onEnvelope } : {}),
});

const resetPolicyConfig = () => {
  delete process.env.MULTISIG_COSIGNERS;
  delete process.env.MULTISIG_COSIGNER_ENDPOINT;
  delete process.env.MULTISIG_COSIGNER_API_KEY;
  multisig.setCoSigners(undefined);
};

beforeEach(() => {
  mock.restoreAll();
  resetPolicyConfig();
});

afterEach(() => {
  mock.restoreAll();
  resetPolicyConfig();
});

// ── The half of the acceptance criteria that must NOT change ─────────────

test('a low-value transfer still submits with a single key', async () => {
  setUpHorizon();

  await pay({ amount: '10' });

  assert.equal(submitCalls, 1);
  assert.equal(lastSubmitted.signatures.length, 1);
});

test('the threshold is exclusive: an amount exactly at it is still single-key', async () => {
  setUpHorizon();

  await pay({ amount: `${THRESHOLD}.0000000` });

  assert.equal(submitCalls, 1);
  assert.equal(lastSubmitted.signatures.length, 1);
});

test('a broken co-signer configuration cannot break a low-value transfer', async () => {
  // If `configuredCoSigners()` were resolved below the threshold it would
  // throw `cosigner_misconfigured` here and the payment would fail. It does
  // not, which is the property: configuration problems are scoped to the
  // transfers that actually need a quorum.
  setUpHorizon();
  process.env.MULTISIG_COSIGNERS = 'definitely-not-a-stellar-key';

  await pay({ amount: '10' });

  assert.equal(submitCalls, 1);
  assert.equal(lastSubmitted.signatures.length, 1);
});

test('a changeTrust envelope stays low tier, so trustlines are never blocked by the gate', async () => {
  const transaction = new StellarSdk.TransactionBuilder(
    new StellarSdk.Account(custody.publicKey(), '1'),
    { fee: '100', networkPassphrase: TESTNET },
  )
    .addOperation(StellarSdk.Operation.changeTrust({ asset: new StellarSdk.Asset('USDC', compliance.publicKey()) }))
    .setTimeout(30)
    .build();
  transaction.sign(custody);

  const authorization = await multisig.authorizeForSubmission({
    transaction,
    accountRecord: asRecord(horizonAccount()),
    networkPassphrase: TESTNET,
    resolveCoSigners: () => { throw new Error('must not be resolved for a trustline'); },
  });

  assert.equal(authorization.quorumRequired, false);
  assert.equal(authorization.tier, multisig.TRANSFER_TIERS.LOW);
});

// ── The half that must now be enforced ──────────────────────────────────

test('a high-value transfer with no co-signer configured is refused before Horizon sees it', async () => {
  setUpHorizon();

  await assert.rejects(
    pay({ amount: '1500' }),
    (error) => error.code === multisig.COSIGNER_ERROR_CODES.COSIGNER_UNAVAILABLE,
  );

  assert.equal(submitCalls, 0, 'nothing reached the network');
});

test('a high-value transfer with a co-signer submits with two distinct signatures', async () => {
  setUpHorizon();
  multisig.setCoSigners([coSignerFrom(compliance)]);

  const seenHashes = [];
  await pay({ amount: '1500', onEnvelope: (hash) => seenHashes.push(hash) });

  assert.equal(submitCalls, 1);
  assert.equal(lastSubmitted.signatures.length, 2);

  // Both signatures must verify against the envelope that was actually sent.
  const hash = lastSubmitted.hash();
  const verified = lastSubmitted.signatures.filter((decorated) => [custody, compliance]
    .some((keypair) => keypair.signatureHint().equals(decorated.hint())
      && keypair.verify(hash, decorated.signature())));
  assert.equal(verified.length, 2, 'the envelope carries two independently verified signatures');
  assert.equal(seenHashes.length, 1, 'the hash is recorded only once, after the gate passed');
});

test('the onEnvelope hook never fires for a refused transaction', async () => {
  // Recording a txHash for something that was never submitted leaves a hash
  // pointing at nothing, and the reconciler would chase it forever.
  setUpHorizon();
  const seenHashes = [];

  await assert.rejects(
    pay({ amount: '1500', onEnvelope: (hash) => seenHashes.push(hash) }),
    (error) => error.code === multisig.COSIGNER_ERROR_CODES.COSIGNER_UNAVAILABLE,
  );

  assert.deepEqual(seenHashes, []);
  assert.equal(submitCalls, 0);
});

const refusalCases = [
  {
    name: 'a malformed public key in MULTISIG_COSIGNERS',
    arrange: () => { process.env.MULTISIG_COSIGNERS = 'compliance=not-a-key'; },
    code: () => multisig.COSIGNER_ERROR_CODES.COSIGNER_MISCONFIGURED,
  },
  {
    name: 'MULTISIG_COSIGNERS set with no endpoint to call',
    arrange: () => { process.env.MULTISIG_COSIGNERS = `compliance=${compliance.publicKey()}`; },
    code: () => multisig.COSIGNER_ERROR_CODES.COSIGNER_MISCONFIGURED,
  },
  {
    name: 'a configured co-signer that is not a signer on this account',
    arrange: () => multisig.setCoSigners([coSignerFrom(outsider)]),
    code: () => multisig.COSIGNER_ERROR_CODES.COSIGNER_MISCONFIGURED,
  },
  {
    name: 'a co-signer that fails to sign',
    arrange: () => multisig.setCoSigners([
      coSignerFrom(compliance, async () => { throw new Error('co-signer offline'); }),
    ]),
    code: () => multisig.COSIGNER_ERROR_CODES.COSIGNER_FAILED,
  },
  {
    name: 'a co-signer that returns a non-signature',
    arrange: () => multisig.setCoSigners([
      coSignerFrom(compliance, async () => Buffer.alloc(64)),
    ]),
    code: () => multisig.COSIGNER_ERROR_CODES.INVALID_COSIGNER_SIGNATURE,
  },
  {
    name: 'a co-signer that signs a DIFFERENT transaction',
    arrange: () => {
      const other = new StellarSdk.TransactionBuilder(
        new StellarSdk.Account(compliance.publicKey(), '9'),
        { fee: '100', networkPassphrase: TESTNET },
      ).addOperation(StellarSdk.Operation.payment({
        destination: DESTINATION, asset: StellarSdk.Asset.native(), amount: '1',
      })).setTimeout(30).build();
      other.sign(compliance);
      multisig.setCoSigners([
        coSignerFrom(compliance, async () => other.signatures[0].signature()),
      ]);
    },
    code: () => multisig.COSIGNER_ERROR_CODES.INVALID_COSIGNER_SIGNATURE,
  },
  {
    name: 'an account record with no signers array at all',
    arrange: () => multisig.setCoSigners([coSignerFrom(compliance)]),
    account: () => horizonAccount({ signers: null }),
    code: () => multisig.MULTISIG_ERROR_CODES.INVALID_ACCOUNT_RECORD,
  },
  {
    name: 'an account whose on-chain high threshold is stricter than the floor',
    arrange: () => multisig.setCoSigners([coSignerFrom(compliance)]),
    account: () => horizonAccount({ thresholds: { low_threshold: 1, med_threshold: 1, high_threshold: 3 } }),
    code: () => multisig.MULTISIG_ERROR_CODES.QUORUM_NOT_MET,
  },
];

for (const item of refusalCases) {
  test(`high-value refusal: ${item.name}`, async () => {
    setUpHorizon({ account: item.account ? item.account() : horizonAccount() });
    item.arrange();

    await assert.rejects(
      pay({ amount: '1500' }),
      (error) => error.code === item.code(),
      `must be refused with ${item.code()}`,
    );

    assert.equal(submitCalls, 0, 'nothing reached the network');
  });
}

test('a rebuilt envelope after tx_bad_seq is gated again — a retry is not a hole', async () => {
  let signCalls = 0;
  multisig.setCoSigners([coSignerFrom(compliance, async ({ hash }) => {
    signCalls += 1;
    if (signCalls > 1) throw new Error('co-signer went offline');
    return compliance.sign(hash);
  })]);

  let submits = 0;
  setUpHorizon({
    submitTransaction: async (transaction) => {
      submits += 1;
      if (submits === 1) {
        const error = new Error('Transaction failed');
        error.response = { data: { extras: { result_codes: { transaction: 'tx_bad_seq' } } } };
        throw error;
      }
      lastSubmitted = transaction;
      return { hash: 'mock-hash', successful: true, ledger: 1 };
    },
  });
  horizonLookupFindsNothing();

  await assert.rejects(
    pay({ amount: '1500' }),
    (error) => error.code === multisig.COSIGNER_ERROR_CODES.COSIGNER_FAILED,
  );

  assert.equal(submits, 1, 'the second attempt never reached Horizon');
  assert.equal(signCalls, 2, 'the rebuilt envelope really was gated');
});

// ── The policy function the adapter calls ────────────────────────────────

const buildEnvelope = ({ amount, signers }) => {
  const transaction = new StellarSdk.TransactionBuilder(
    new StellarSdk.Account(custody.publicKey(), '1'),
    { fee: '100', networkPassphrase: TESTNET },
  ).addOperation(StellarSdk.Operation.payment({
    destination: DESTINATION,
    asset: StellarSdk.Asset.native(),
    amount,
  })).setTimeout(30).build();
  for (const keypair of signers) transaction.sign(keypair);
  return transaction;
};

test('authorizeForSubmission: a duplicate signature still counts once', async () => {
  const transaction = buildEnvelope({ amount: '5000', signers: [] });
  // One key, signing twice — the classic way to fake a 2-of-3.
  transaction.sign(custody);
  transaction.sign(custody);

  const authorization = await multisig.authorizeForSubmission({
    transaction,
    accountRecord: asRecord(horizonAccount()),
    networkPassphrase: TESTNET,
    resolveCoSigners: () => [coSignerFrom(compliance)],
  });

  assert.equal(authorization.quorumRequired, true);
  assert.deepEqual(
    [...authorization.validSigners].sort(),
    [compliance.publicKey(), custody.publicKey()].sort(),
  );
  assert.equal(authorization.totalWeight, 2, 'two signatures from one key bought nothing');
});

test('authorizeForSubmission: a missing second signature is refused', async () => {
  const transaction = buildEnvelope({ amount: '5000', signers: [custody] });

  await assert.rejects(
    multisig.authorizeForSubmission({
      transaction,
      accountRecord: asRecord(horizonAccount()),
      networkPassphrase: TESTNET,
      resolveCoSigners: () => [],
    }),
    (error) => error.code === multisig.COSIGNER_ERROR_CODES.COSIGNER_UNAVAILABLE,
  );
});

test('authorizeForSubmission: an invalid second signature is refused', async () => {
  const transaction = buildEnvelope({ amount: '5000', signers: [custody] });

  await assert.rejects(
    multisig.authorizeForSubmission({
      transaction,
      accountRecord: asRecord(horizonAccount()),
      networkPassphrase: TESTNET,
      resolveCoSigners: () => [coSignerFrom(compliance, async () => Buffer.alloc(64))],
    }),
    (error) => error.code === multisig.COSIGNER_ERROR_CODES.INVALID_COSIGNER_SIGNATURE,
  );
});

test('authorizeForSubmission: an on-chain threshold stricter than the policy floor is honoured', async () => {
  const transaction = buildEnvelope({ amount: '5000', signers: [custody] });

  await assert.rejects(
    multisig.authorizeForSubmission({
      transaction,
      accountRecord: asRecord(horizonAccount({
        thresholds: { low_threshold: 1, med_threshold: 1, high_threshold: 3 },
      })),
      networkPassphrase: TESTNET,
      // Only one co-signer, so custody (1) + compliance (1) = 2 against an
      // on-chain requirement of 3. The policy floor of 2 does not win here:
      // the stricter of the two governs.
      resolveCoSigners: () => [coSignerFrom(compliance)],
    }),
    (error) => error.code === multisig.MULTISIG_ERROR_CODES.QUORUM_NOT_MET
      && error.requiredWeight === 3
      && error.totalWeight === 2,
  );
});

test('authorizeForSubmission: below the threshold it never resolves a co-signer at all', async () => {
  const transaction = buildEnvelope({ amount: '10', signers: [custody] });

  const authorization = await multisig.authorizeForSubmission({
    transaction,
    accountRecord: asRecord(horizonAccount()),
    networkPassphrase: TESTNET,
    resolveCoSigners: () => { throw new Error('must not be called'); },
  });

  assert.equal(authorization.quorumRequired, false);
  assert.equal(authorization.tier, multisig.TRANSFER_TIERS.LOW);
});

// ── No alternate submission path ────────────────────────────────────────

const SRC_ROOT = path.resolve(__dirname, '../src');

const walkJs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return walkJs(full);
  return entry.name.endsWith('.js') ? [full] : [];
});

const collectRequires = (file) => {
  const source = fs.readFileSync(file, 'utf8');
  const found = [];
  const pattern = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match = pattern.exec(source);
  while (match !== null) {
    const spec = match[1];
    if (spec.startsWith('.')) {
      const base = path.resolve(path.dirname(file), spec);
      for (const candidate of [`${base}.js`, path.join(base, 'index.js'), base]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          found.push(candidate);
          break;
        }
      }
    }
    match = pattern.exec(source);
  }
  return found;
};

test('the gated adapter is the only reachable Horizon payment path', () => {
  const allFiles = walkJs(SRC_ROOT);

  // 1. The gate cannot be silently dropped from the adapter.
  const adapter = fs.readFileSync(path.join(SRC_ROOT, 'wallet/stellar.adapter.js'), 'utf8');
  assert.match(adapter, /authorizeForSubmission\(/, 'the adapter must call the quorum gate');
  assert.match(adapter, /server\.submitTransaction\(/, 'the adapter is the submitter');

  // 2. Every OTHER module that submits straight to Horizon has to stay
  //    accounted for. The gate lives in the adapter, so a module that calls
  //    `server.submitTransaction` itself is outside it by construction; the
  //    only thing keeping that from becoming a bypass of #959 is that each
  //    such module is either dormant or provably zero-value. This assertion
  //    is the tripwire: wiring one of them in, or giving `feeBump` a second
  //    caller, fails here instead of silently widening the ungated surface.
  const reachable = new Set();
  const queue = ['server.js', 'worker.js'].map((name) => path.join(SRC_ROOT, name));
  while (queue.length > 0) {
    const current = queue.pop();
    if (reachable.has(current) || !fs.existsSync(current)) continue;
    reachable.add(current);
    queue.push(...collectRequires(current));
  }

  const callersOf = (relative) => {
    const full = path.join(SRC_ROOT, relative);
    return allFiles
      .filter((file) => file !== full && collectRequires(file).includes(full))
      .map((file) => path.relative(SRC_ROOT, file));
  };

  // `feeBump.js` is reachable as of #1066: `trustlines.js` uses
  // `buildFeeBumpEnvelope` to wrap a ChangeTrust, which moves no value and is
  // exempt on purpose (ZERO_VALUE_OPERATIONS). That ONE caller is accepted.
  // `feeBump.js` itself is generic and submits to Horizon directly, so a
  // second caller could hand it a valued inner transaction — hence an
  // allowlist rather than a blanket pass.
  // Subset, not equality: `trustlines.js` arrives with #1066, so on a base
  // that predates it the sanctioned caller is simply absent. What must never
  // happen is an UNSANCTIONED caller appearing.
  const feeBumpCallers = callersOf('wallet/feeBump.js');
  const sanctionedFeeBumpCallers = ['wallet/trustlines.js'];
  assert.deepEqual(
    feeBumpCallers.filter((caller) => !sanctionedFeeBumpCallers.includes(caller)).sort(),
    [],
    'feeBump.js submits straight to Horizon; its only sanctioned caller wraps a '
    + 'zero-value ChangeTrust. A new caller must gate its own submissions (#959).',
  );

  // These submit to Horizon directly and are NOT zero-value.
  // `channelAccountPool.js` is operational plumbing; `hotWalletPool.js`
  // (#1081) builds native payments of arbitrary size from cold storage and
  // signs them with raw in-process keypairs under its own ad-hoc quorum.
  // Both are dormant today — nothing requires them — which is the only
  // reason they are not live bypasses of this policy.
  for (const dormant of ['wallet/channelAccountPool.js', 'wallet/hotWalletPool.js']) {
    const full = path.join(SRC_ROOT, dormant);
    if (!fs.existsSync(full)) continue;
    assert.deepEqual(
      callersOf(dormant),
      [],
      `${dormant} submits valued transactions straight to Horizon, so wiring it in `
      + 'without gating it would bypass #959',
    );
    assert.equal(
      reachable.has(full),
      false,
      `${dormant} must stay unreachable until its own submissions are gated`,
    );
  }
});
