// Multi-signature quorum policy tests (#959).
//
// The guarantees under test:
//
//   * a low-value transfer still works with ONE key (half the acceptance
//     criterion, and the easiest thing to regress);
//   * a high-value transfer needs TWO valid signatures from two DIFFERENT
//     account signers;
//   * signatures are verified cryptographically, so a non-signer, an invalid
//     blob, a duplicate, or a signature from another network never counts;
//   * the tier is decided by TOTAL value, so splitting a transfer across
//     operations or hiding it in a fee bump does not duck the threshold;
//   * an operation the policy cannot value fails CLOSED;
//   * a refused transaction is never submitted.
//
// Every keypair is generated at runtime — no secret is ever committed.
// Nothing touches the network.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const StellarSdk = require('@stellar/stellar-sdk');
const multisig = require('../src/wallet/multisig');

const TESTNET = StellarSdk.Networks.TESTNET;
const PUBLIC = StellarSdk.Networks.PUBLIC;

// Three throwaway quorum members, generated per-run.
const custody = StellarSdk.Keypair.random();
const compliance = StellarSdk.Keypair.random();
const operator = StellarSdk.Keypair.random();
const outsider = StellarSdk.Keypair.random();

const DESTINATION = StellarSdk.Keypair.random().publicKey();

/** A Horizon-shaped account record for the custody account. */
const accountRecord = ({
  signers = [
    { key: custody.publicKey(), weight: 1, type: 'ed25519_public_key' },
    { key: compliance.publicKey(), weight: 1, type: 'ed25519_public_key' },
    { key: operator.publicKey(), weight: 1, type: 'ed25519_public_key' },
  ],
  thresholds = { low_threshold: 1, med_threshold: 1, high_threshold: 2 },
} = {}) => ({ account_id: custody.publicKey(), signers, thresholds });

/**
 * Build a transaction with the given payment amounts, signed by `signers`.
 *
 * @param {object} params
 * @param {Array<{amount: string, asset?: object, source?: string}>} params.payments
 * @param {object[]} params.signers - Keypairs to sign with.
 * @param {string} params.networkPassphrase
 * @param {object[]} [params.extraOps] - Raw operations to append.
 */
const buildTx = ({ payments = [], signers = [], networkPassphrase = TESTNET, extraOps = [] }) => {
  const source = new StellarSdk.Account(custody.publicKey(), '1');
  const builder = new StellarSdk.TransactionBuilder(source, {
    fee: '100',
    networkPassphrase,
  });

  for (const p of payments) {
    builder.addOperation(StellarSdk.Operation.payment({
      destination: DESTINATION,
      asset: p.asset || StellarSdk.Asset.native(),
      amount: p.amount,
      ...(p.source ? { source: p.source } : {}),
    }));
  }
  for (const op of extraOps) builder.addOperation(op);

  const tx = builder.setTimeout(30).build();
  for (const kp of signers) tx.sign(kp);
  return tx;
};

// ── Tier classification ───────────────────────────────────────────────────

test('a small single payment is low tier and needs no quorum', () => {
  const tx = buildTx({ payments: [{ amount: '10' }] });
  const c = multisig.classifyTransaction({ transaction: tx, threshold: '1000' });

  assert.equal(c.tier, multisig.TRANSFER_TIERS.LOW);
  assert.equal(c.requiresQuorum, false);
  // The SDK normalises amounts to 7 decimals, so compare numerically.
  assert.equal(Number(c.totalsByAsset.XLM), 10);
});

test('a payment over the threshold is high tier', () => {
  const tx = buildTx({ payments: [{ amount: '5000' }] });
  const c = multisig.classifyTransaction({ transaction: tx, threshold: '1000' });

  assert.equal(c.tier, multisig.TRANSFER_TIERS.HIGH);
  assert.equal(c.requiresQuorum, true);
});

test('exactly at the threshold is NOT over it; one unit above is', () => {
  const at = multisig.classifyTransaction({
    transaction: buildTx({ payments: [{ amount: '1000' }] }), threshold: '1000',
  });
  assert.equal(at.tier, multisig.TRANSFER_TIERS.LOW, 'the threshold is exclusive');

  const over = multisig.classifyTransaction({
    transaction: buildTx({ payments: [{ amount: '1000.0000001' }] }), threshold: '1000',
  });
  assert.equal(over.tier, multisig.TRANSFER_TIERS.HIGH);
});

test('BYPASS: splitting a transfer across operations does not duck the threshold', () => {
  // Four payments of 300 look individually small; the envelope moves 1200.
  const tx = buildTx({
    payments: [{ amount: '300' }, { amount: '300' }, { amount: '300' }, { amount: '300' }],
  });
  const c = multisig.classifyTransaction({ transaction: tx, threshold: '1000' });

  assert.equal(Number(c.totalsByAsset.XLM), 1200);
  assert.equal(c.tier, multisig.TRANSFER_TIERS.HIGH, 'the TOTAL decides the tier');
});

test('BYPASS: a fee bump does not downgrade the inner transaction', () => {
  const inner = buildTx({ payments: [{ amount: '5000' }], signers: [custody] });
  const feeBump = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
    operator, '2000', inner, TESTNET,
  );

  const c = multisig.classifyTransaction({ transaction: feeBump, threshold: '1000' });
  assert.equal(c.feeBumped, true);
  assert.equal(c.tier, multisig.TRANSFER_TIERS.HIGH, 'the inner value still governs');
  assert.equal(Number(c.totalsByAsset.XLM), 5000);
});

test('BYPASS: an unvaluable operation FAILS CLOSED into the high tier', () => {
  // accountMerge moves the entire balance and carries no amount field. If it
  // were treated as zero-value, it would be the perfect bypass.
  const tx = buildTx({
    payments: [],
    extraOps: [StellarSdk.Operation.accountMerge({ destination: DESTINATION })],
  });
  const c = multisig.classifyTransaction({ transaction: tx, threshold: '1000' });

  assert.equal(c.tier, multisig.TRANSFER_TIERS.HIGH);
  assert.ok(c.unvalued.includes('accountMerge'));
  assert.match(c.reasons.join(' '), /unbounded value/);
});

test('genuinely zero-value operations stay low tier', () => {
  const tx = buildTx({
    payments: [],
    extraOps: [StellarSdk.Operation.changeTrust({
      asset: new StellarSdk.Asset('USDC', outsider.publicKey()),
    })],
  });
  const c = multisig.classifyTransaction({ transaction: tx, threshold: '1000' });
  assert.equal(c.tier, multisig.TRANSFER_TIERS.LOW);
  assert.deepEqual(c.unvalued, []);
});

test('BYPASS: an operation-level source override is recorded', () => {
  const other = StellarSdk.Keypair.random().publicKey();
  const tx = buildTx({ payments: [{ amount: '50', source: other }] });
  const c = multisig.classifyTransaction({ transaction: tx, threshold: '1000' });
  assert.match(c.reasons.join(' '), /overrides source/);
});

// ── Threshold plan ────────────────────────────────────────────────────────

test('buildThresholdPlan expresses a real 2-of-3 arithmetically', () => {
  const plan = multisig.buildThresholdPlan({
    signers: [custody.publicKey(), compliance.publicKey(), operator.publicKey()],
  });

  assert.equal(plan.highThreshold, 2);
  assert.equal(plan.masterWeight, 1);
  assert.equal(plan.additionalSigners.length, 2);
  assert.ok(plan.additionalSigners.every((s) => s.weight === 1));

  // Any two of three clear the high threshold...
  assert.ok(plan.masterWeight + plan.additionalSigners[0].weight >= plan.highThreshold);
  // ...and no single key does.
  assert.ok(plan.masterWeight < plan.highThreshold);
  assert.ok(plan.additionalSigners.every((s) => s.weight < plan.highThreshold));
  // Low-value single-key operation is preserved.
  assert.equal(plan.lowThreshold, 1);
  assert.equal(plan.medThreshold, 1);
  // The plan is data, never applied by this module.
  assert.equal(plan.applied, false);
});

test('buildThresholdPlan rejects wrong signer counts, duplicates and bad keys', () => {
  assert.throws(() => multisig.buildThresholdPlan({ signers: [custody.publicKey()] }));
  assert.throws(
    () => multisig.buildThresholdPlan({
      signers: [custody.publicKey(), custody.publicKey(), operator.publicKey()],
    }),
    (e) => e.code === multisig.MULTISIG_ERROR_CODES.DUPLICATE_SIGNATURE,
  );
  assert.throws(
    () => multisig.buildThresholdPlan({
      signers: [custody.publicKey(), compliance.publicKey(), 'not-a-key'],
    }),
    (e) => e.code === multisig.MULTISIG_ERROR_CODES.UNAUTHORIZED_SIGNER,
  );
});

// ── Acceptance criterion: low value, single key ───────────────────────────

test('ACCEPTANCE: a low-value transfer is authorized by a single key', () => {
  const tx = buildTx({ payments: [{ amount: '10' }], signers: [custody] });
  const result = multisig.authorizeTransaction({
    transaction: tx,
    accountRecord: accountRecord(),
    networkPassphrase: TESTNET,
    threshold: '1000',
  });

  assert.equal(result.authorized, true);
  assert.equal(result.tier, multisig.TRANSFER_TIERS.LOW);
  assert.equal(result.totalWeight, 1);
  assert.equal(result.requiredWeight, 1);
});

// ── Acceptance criterion: high value, two signatures ─────────────────────

test('ACCEPTANCE: a high-value transfer with ONE signature is refused', () => {
  const tx = buildTx({ payments: [{ amount: '5000' }], signers: [custody] });

  assert.throws(
    () => multisig.authorizeTransaction({
      transaction: tx,
      accountRecord: accountRecord(),
      networkPassphrase: TESTNET,
      threshold: '1000',
    }),
    (err) => {
      assert.equal(err.code, multisig.MULTISIG_ERROR_CODES.QUORUM_NOT_MET);
      assert.equal(err.totalWeight, 1);
      assert.equal(err.requiredWeight, 2);
      return true;
    },
  );
});

test('ACCEPTANCE: a high-value transfer with TWO valid signatures is authorized', () => {
  const tx = buildTx({ payments: [{ amount: '5000' }], signers: [custody, compliance] });
  const result = multisig.authorizeTransaction({
    transaction: tx,
    accountRecord: accountRecord(),
    networkPassphrase: TESTNET,
    threshold: '1000',
  });

  assert.equal(result.authorized, true);
  assert.equal(result.tier, multisig.TRANSFER_TIERS.HIGH);
  assert.equal(result.totalWeight, 2);
  assert.deepEqual(
    result.validSigners.sort(),
    [custody.publicKey(), compliance.publicKey()].sort(),
  );
});

test('any two of the three quorum members suffice', () => {
  const pairs = [[custody, compliance], [custody, operator], [compliance, operator]];
  for (const signers of pairs) {
    const tx = buildTx({ payments: [{ amount: '5000' }], signers });
    const result = multisig.authorizeTransaction({
      transaction: tx,
      accountRecord: accountRecord(),
      networkPassphrase: TESTNET,
      threshold: '1000',
    });
    assert.equal(result.totalWeight, 2);
  }
});

// ── Signature verification ────────────────────────────────────────────────

test('a DUPLICATE signature from one signer counts once and never reaches quorum', () => {
  // The classic bypass: one compromised key signs twice to fake 2-of-3.
  const tx = buildTx({ payments: [{ amount: '5000' }], signers: [custody] });
  // Append the identical decorated signature a second time.
  tx.signatures.push(tx.signatures[0]);
  assert.equal(tx.signatures.length, 2, 'two signature blobs are present');

  const v = multisig.verifySignatures({
    transaction: tx, accountRecord: accountRecord(), networkPassphrase: TESTNET,
  });
  assert.equal(v.validSigners.length, 1, 'counted once');
  assert.equal(v.totalWeight, 1);
  assert.deepEqual(v.duplicates, [custody.publicKey()]);

  assert.throws(
    () => multisig.authorizeTransaction({
      transaction: tx,
      accountRecord: accountRecord(),
      networkPassphrase: TESTNET,
      threshold: '1000',
    }),
    (e) => e.code === multisig.MULTISIG_ERROR_CODES.QUORUM_NOT_MET,
  );
});

test('a signature from a key that is NOT a signer does not count', () => {
  const tx = buildTx({ payments: [{ amount: '5000' }], signers: [custody, outsider] });
  const v = multisig.verifySignatures({
    transaction: tx, accountRecord: accountRecord(), networkPassphrase: TESTNET,
  });

  assert.equal(v.totalWeight, 1, 'only the real signer counts');
  assert.equal(v.unauthorized, 1);
  assert.ok(!v.validSigners.includes(outsider.publicKey()));

  assert.throws(() => multisig.authorizeTransaction({
    transaction: tx,
    accountRecord: accountRecord(),
    networkPassphrase: TESTNET,
    threshold: '1000',
  }));
});

test('two signatures where one is a non-signer still fails the quorum', () => {
  const tx = buildTx({ payments: [{ amount: '5000' }], signers: [compliance, outsider] });
  assert.throws(
    () => multisig.authorizeTransaction({
      transaction: tx,
      accountRecord: accountRecord(),
      networkPassphrase: TESTNET,
      threshold: '1000',
    }),
    (e) => e.code === multisig.MULTISIG_ERROR_CODES.QUORUM_NOT_MET && e.totalWeight === 1,
  );
});

test('a cryptographically INVALID signature blob does not count', () => {
  const tx = buildTx({ payments: [{ amount: '5000' }], signers: [custody, compliance] });
  // Corrupt the compliance signature's bytes while keeping its hint intact,
  // so only real verification can reject it.
  const victim = tx.signatures[1];
  const corrupted = Buffer.from(victim.signature());
  corrupted[0] ^= 0xff;
  tx.signatures[1] = new StellarSdk.xdr.DecoratedSignature({
    hint: victim.hint(),
    signature: corrupted,
  });

  const v = multisig.verifySignatures({
    transaction: tx, accountRecord: accountRecord(), networkPassphrase: TESTNET,
  });
  assert.equal(v.totalWeight, 1, 'the corrupted signature is rejected');
  assert.equal(v.invalid, 1, 'its hint matched a signer, but verification failed');
});

test('a weight-0 (revoked) signer contributes nothing', () => {
  const tx = buildTx({ payments: [{ amount: '10' }], signers: [compliance] });
  const record = accountRecord({
    signers: [
      { key: custody.publicKey(), weight: 1, type: 'ed25519_public_key' },
      { key: compliance.publicKey(), weight: 0, type: 'ed25519_public_key' },
      { key: operator.publicKey(), weight: 1, type: 'ed25519_public_key' },
    ],
  });

  assert.throws(
    () => multisig.authorizeTransaction({
      transaction: tx, accountRecord: record, networkPassphrase: TESTNET, threshold: '1000',
    }),
    (e) => e.code === multisig.MULTISIG_ERROR_CODES.NO_SIGNATURES,
  );
});

test('an account record with no signers array is refused, not assumed open', () => {
  const tx = buildTx({ payments: [{ amount: '10' }], signers: [custody] });
  assert.throws(
    () => multisig.verifySignatures({
      transaction: tx, accountRecord: { account_id: 'x' }, networkPassphrase: TESTNET,
    }),
    (e) => e.code === multisig.MULTISIG_ERROR_CODES.INVALID_ACCOUNT_RECORD,
  );
});

test('a stricter on-chain high threshold is honoured over the policy floor', () => {
  const tx = buildTx({ payments: [{ amount: '5000' }], signers: [custody, compliance] });
  const record = accountRecord({
    thresholds: { low_threshold: 1, med_threshold: 1, high_threshold: 3 },
  });

  assert.throws(
    () => multisig.authorizeTransaction({
      transaction: tx, accountRecord: record, networkPassphrase: TESTNET, threshold: '1000',
    }),
    (e) => e.code === multisig.MULTISIG_ERROR_CODES.QUORUM_NOT_MET && e.requiredWeight === 3,
  );
});

// ── Network binding / replay ──────────────────────────────────────────────

test('REPLAY: signatures gathered on testnet do not authorize on mainnet', () => {
  const tx = buildTx({
    payments: [{ amount: '5000' }], signers: [custody, compliance], networkPassphrase: TESTNET,
  });

  // Same operations, same signatures, evaluated against the public network.
  const v = multisig.verifySignatures({
    transaction: tx, accountRecord: accountRecord(), networkPassphrase: PUBLIC,
  });
  assert.equal(v.totalWeight, 0, 'no signature binds to the other network');

  assert.throws(
    () => multisig.authorizeTransaction({
      transaction: tx, accountRecord: accountRecord(), networkPassphrase: PUBLIC, threshold: '1000',
    }),
    (e) => e.code === multisig.MULTISIG_ERROR_CODES.NO_SIGNATURES,
  );
});

test('REPLAY: a signature for a DIFFERENT transaction does not transfer', () => {
  const genuine = buildTx({ payments: [{ amount: '5000' }], signers: [custody, compliance] });
  const target = buildTx({ payments: [{ amount: '9999' }], signers: [custody] });

  // Graft the compliance signature from the genuine transaction onto another.
  target.signatures.push(genuine.signatures[1]);

  const v = multisig.verifySignatures({
    transaction: target, accountRecord: accountRecord(), networkPassphrase: TESTNET,
  });
  assert.equal(v.totalWeight, 1, 'only the signature actually made for this tx counts');
  assert.equal(v.invalid, 1);
});

// ── The submit gate ───────────────────────────────────────────────────────

test('a refused high-value transfer is NEVER submitted', async () => {
  let submitCalls = 0;
  const submit = async () => { submitCalls += 1; return { hash: 'nope' }; };
  const tx = buildTx({ payments: [{ amount: '5000' }], signers: [custody] });

  await assert.rejects(
    () => multisig.submitAuthorized({
      transaction: tx,
      accountRecord: accountRecord(),
      networkPassphrase: TESTNET,
      submit,
      threshold: '1000',
    }),
    (e) => e.code === multisig.MULTISIG_ERROR_CODES.QUORUM_NOT_MET,
  );

  assert.equal(submitCalls, 0, 'submit must not be reached when authorization fails');
});

test('an authorized transfer IS submitted, exactly once', async () => {
  let submitCalls = 0;
  const submit = async () => { submitCalls += 1; return { hash: 'abc' }; };
  const tx = buildTx({ payments: [{ amount: '5000' }], signers: [custody, operator] });

  const { authorization, result } = await multisig.submitAuthorized({
    transaction: tx,
    accountRecord: accountRecord(),
    networkPassphrase: TESTNET,
    submit,
    threshold: '1000',
  });

  assert.equal(authorization.authorized, true);
  assert.equal(authorization.tier, multisig.TRANSFER_TIERS.HIGH);
  assert.equal(result.hash, 'abc');
  assert.equal(submitCalls, 1);
});

test('every bypass vector is refused without submitting', async () => {
  const cases = [
    ['split operations', buildTx({
      payments: [{ amount: '600' }, { amount: '600' }], signers: [custody],
    })],
    ['duplicate signature', (() => {
      const tx = buildTx({ payments: [{ amount: '5000' }], signers: [custody] });
      tx.signatures.push(tx.signatures[0]);
      return tx;
    })()],
    ['unvaluable operation', buildTx({
      payments: [], signers: [custody],
      extraOps: [StellarSdk.Operation.accountMerge({ destination: DESTINATION })],
    })],
  ];

  for (const [label, tx] of cases) {
    let submitCalls = 0;
    await assert.rejects(
      () => multisig.submitAuthorized({
        transaction: tx,
        accountRecord: accountRecord(),
        networkPassphrase: TESTNET,
        submit: async () => { submitCalls += 1; },
        threshold: '1000',
      }),
      `${label} must be refused`,
    );
    assert.equal(submitCalls, 0, `${label} must not submit`);
  }
});

test('no error message leaks key material or signature bytes', () => {
  const tx = buildTx({ payments: [{ amount: '5000' }], signers: [custody] });
  try {
    multisig.authorizeTransaction({
      transaction: tx, accountRecord: accountRecord(), networkPassphrase: TESTNET, threshold: '1000',
    });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(!err.message.includes(custody.secret()));
    assert.ok(!/^S[A-Z2-7]{55}$/m.test(err.message));
  }
});
