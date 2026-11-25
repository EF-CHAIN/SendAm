// BIP-39 recovery phrase and secure export tests (#960).
//
// ── On the secret keys in this file ──────────────────────────────────────
//
// The `S...` keys below are the OFFICIAL SEP-0005 test vectors, published in
// the Stellar protocol specification at
// ecosystem/sep-0005.md. They are public, deliberately
// so, and exist precisely to let implementations prove their derivation is
// correct. They control no funds. Committing them is correct; if the secret
// scanner flags them, that is a false positive to allowlist, not a leak.
//
// Every other key in this file is generated at runtime.
//
// ── What is under test ──────────────────────────────────────────────────
//
//   * derivation matches the spec exactly — all 5 vector sets, several
//     account indices, and the BIP-39 passphrase case;
//   * a generated 12-word phrase is valid and reproduces its own account;
//   * export needs BOTH a PIN and the out-of-band challenge, is single-use,
//     expires, and survives a concurrent double-consume;
//   * a client-supplied "verified" flag cannot authorize anything;
//   * no secret ever reaches a log, an error, an audit record or the grant row;
//   * a legacy Keypair.random() wallet NEVER receives a fabricated mnemonic.

'use strict';

// A dummy encryption key so crypto.service loads offline, following the
// convention in the rest of the suite. It encrypts nothing real here: the
// decrypt path is injected in every export test.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.PIN_PEPPER = process.env.PIN_PEPPER || 'test-only-pin-pepper';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Stub the modules that reach for Postgres or KMS before the SUT loads.
const injectMock = (relFromSrc, factory) => {
  const abs = path.resolve(__dirname, '../src', `${relFromSrc}.js`);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: factory() };
};

const auditLog = [];
injectMock('common/prisma', () => ({}));
injectMock('common/audit.service', () => ({
  writeAuditLog: async (entry) => { auditLog.push(entry); return entry; },
  verifyAuditLogIntegrity: async () => ({ valid: true, errors: [] }),
}));

const loggedLines = [];
injectMock('utils/logger', () => {
  const record = (level) => (...args) => loggedLines.push(`${level} ${args.map(String).join(' ')}`);
  return {
    info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug'),
  };
});

const StellarSdk = require('@stellar/stellar-sdk');
const mnemonicService = require('../src/wallet/mnemonic.service');

// ── Official SEP-0005 test vectors (public spec data) ────────────────────

const SEP5_VECTORS = [
  {
    label: 'Test 1 (12 words)',
    mnemonic: 'illness spike retreat truth genius clock brain pass fit cave bargain toe',
    passphrase: '',
    accounts: [
      ["m/44'/148'/0'", 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6', 'SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN'],
      ["m/44'/148'/1'", 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX', 'SCEPFFWGAG5P2VX5DHIYK3XEMZYLTYWIPWYEKXFHSK25RVMIUNJ7CTIS'],
      ["m/44'/148'/2'", 'GAY5PRAHJ2HIYBYCLZXTHID6SPVELOOYH2LBPH3LD4RUMXUW3DOYTLXW', 'SDAILLEZCSA67DUEP3XUPZJ7NYG7KGVRM46XA7K5QWWUIGADUZCZWTJP'],
    ],
  },
  {
    label: 'Test 2 (15 words)',
    mnemonic: 'resource asthma orphan phone ice canvas fire useful arch jewel impose vague theory cushion top',
    passphrase: '',
    accounts: [
      ["m/44'/148'/0'", 'GAVXVW5MCK7Q66RIBWZZKZEDQTRXWCZUP4DIIFXCCENGW2P6W4OA34RH', 'SAKS7I2PNDBE5SJSUSU2XLJ7K5XJ3V3K4UDFAHMSBQYPOKE247VHAGDB'],
      ["m/44'/148'/1'", 'GDFCYVCICATX5YPJUDS22KM2GW5QU2KKSPPPT2IC5AQIU6TP3BZSLR5K', 'SAZ2H5GLAVWCUWNPQMB6I3OHRI63T2ACUUAWSH7NAGYYPXGIOPLPW3Q4'],
    ],
  },
  {
    label: 'Test 3 (24 words)',
    mnemonic: 'bench hurt jump file august wise shallow faculty impulse spring exact slush thunder author capable act festival slice deposit sauce coconut afford frown better',
    passphrase: '',
    accounts: [
      ["m/44'/148'/0'", 'GC3MMSXBWHL6CPOAVERSJITX7BH76YU252WGLUOM5CJX3E7UCYZBTPJQ', 'SAEWIVK3VLNEJ3WEJRZXQGDAS5NVG2BYSYDFRSH4GKVTS5RXNVED5AX7'],
      ["m/44'/148'/1'", 'GB3MTYFXPBZBUINVG72XR7AQ6P2I32CYSXWNRKJ2PV5H5C7EAM5YYISO', 'SBKSABCPDWXDFSZISAVJ5XKVIEWV4M5O3KBRRLSPY3COQI7ZP423FYB4'],
      ["m/44'/148'/2'", 'GDYF7GIHS2TRGJ5WW4MZ4ELIUIBINRNYPPAWVQBPLAZXC2JRDI4DGAKU', 'SD5CCQAFRIPB3BWBHQYQ5SC66IB2AVMFNWWPBYGSUXVRZNCIRJ7IHESQ'],
    ],
  },
  {
    label: 'Test 4 (24 words + BIP-39 passphrase)',
    mnemonic: 'cable spray genius state float twenty onion head street palace net private method loan turn phrase state blanket interest dry amazing dress blast tube',
    passphrase: 'p4ssphr4se',
    accounts: [
      ["m/44'/148'/0'", 'GDAHPZ2NSYIIHZXM56Y36SBVTV5QKFIZGYMMBHOU53ETUSWTP62B63EQ', 'SAFWTGXVS7ELMNCXELFWCFZOPMHUZ5LXNBGUVRCY3FHLFPXK4QPXYP2X'],
      ["m/44'/148'/1'", 'GDY47CJARRHHL66JH3RJURDYXAMIQ5DMXZLP3TDAUJ6IN2GUOFX4OJOC', 'SBQPDFUGLMWJYEYXFRM5TQX3AX2BR47WKI4FDS7EJQUSEUUVY72MZPJF'],
    ],
  },
  {
    label: 'Test 5 (12 words, all-zero entropy)',
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    passphrase: '',
    accounts: [
      ["m/44'/148'/0'", 'GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX', 'SBUV3MRWKNS6AYKZ6E6MOUVF2OYMON3MIUASWL3JLY5E3ISDJFELYBRZ'],
      ["m/44'/148'/1'", 'GDVSYYTUAJ3ACHTPQNSTQBDQ4LDHQCMNY4FCEQH5TJUMSSLWQSTG42MV', 'SCHDCVCWGAKGIMTORV6K5DYYV3BY4WG3RA4M6MCBGJLHUCWU2MC6DL66'],
    ],
  },
];

// ── Derivation against the spec ──────────────────────────────────────────

test('SEP-0005: every official test vector derives exactly', () => {
  let checked = 0;
  for (const vector of SEP5_VECTORS) {
    for (const [expectedPath, expectedPublic, expectedSecret] of vector.accounts) {
      const accountIndex = Number(expectedPath.match(/(\d+)'$/)[1]);
      const derived = mnemonicService.deriveStellarKeypair({
        mnemonic: vector.mnemonic,
        passphrase: vector.passphrase || undefined,
        accountIndex,
      });

      assert.equal(derived.path, expectedPath, `${vector.label} path`);
      assert.equal(derived.publicKey, expectedPublic, `${vector.label} ${expectedPath} public key`);
      assert.equal(derived.secretKey, expectedSecret, `${vector.label} ${expectedPath} secret key`);
      checked += 1;
    }
  }
  assert.ok(checked >= 12, `expected to check at least 12 vector accounts, checked ${checked}`);
});

test('SEP-0005: the BIP-39 passphrase changes the derived account', () => {
  const vector = SEP5_VECTORS.find((v) => v.passphrase);
  const withPass = mnemonicService.deriveStellarKeypair({
    mnemonic: vector.mnemonic, passphrase: vector.passphrase, accountIndex: 0,
  });
  const withoutPass = mnemonicService.deriveStellarKeypair({
    mnemonic: vector.mnemonic, accountIndex: 0,
  });

  assert.equal(withPass.publicKey, vector.accounts[0][1]);
  assert.notEqual(
    withoutPass.publicKey, withPass.publicKey,
    'omitting the passphrase must not silently derive the same account',
  );
});

test('the derivation path is SEP-0005 m/44/148/x with every element hardened', () => {
  assert.equal(mnemonicService.derivationPathFor(0), "m/44'/148'/0'");
  assert.equal(mnemonicService.derivationPathFor(7), "m/44'/148'/7'");
  assert.equal(mnemonicService.STELLAR_COIN_TYPE, 148);
});

test('an out-of-range account index is rejected', () => {
  for (const bad of [-1, 1.5, 2 ** 31, Number.NaN, '0']) {
    assert.throws(
      () => mnemonicService.derivationPathFor(bad),
      (e) => e.code === mnemonicService.EXPORT_ERROR_CODES.INVALID_ACCOUNT_INDEX,
      `${String(bad)} must be rejected`,
    );
  }
});

test('different account indices derive different accounts', () => {
  const v = SEP5_VECTORS[0];
  const a = mnemonicService.deriveStellarKeypair({ mnemonic: v.mnemonic, accountIndex: 0 });
  const b = mnemonicService.deriveStellarKeypair({ mnemonic: v.mnemonic, accountIndex: 1 });
  assert.notEqual(a.publicKey, b.publicKey);
});

// ── Generation and validation ───────────────────────────────────────────

test('a generated phrase is 12 valid English words and reproduces its own account', () => {
  const mnemonic = mnemonicService.generateMnemonic();
  const words = mnemonic.split(' ');

  assert.equal(words.length, 12);
  assert.equal(mnemonicService.validateMnemonic(mnemonic), true);

  const bip39 = require('bip39');
  for (const word of words) {
    assert.ok(bip39.wordlists.english.includes(word), `${word} must be in the English wordlist`);
  }

  // Deriving twice from the same phrase must be deterministic.
  const first = mnemonicService.deriveStellarKeypair({ mnemonic });
  const second = mnemonicService.deriveStellarKeypair({ mnemonic });
  assert.equal(first.publicKey, second.publicKey);
  assert.ok(StellarSdk.StrKey.isValidEd25519PublicKey(first.publicKey));
});

test('24-word generation is supported and two generations differ', () => {
  const a = mnemonicService.generateMnemonic({ strength: 256 });
  const b = mnemonicService.generateMnemonic({ strength: 256 });
  assert.equal(a.split(' ').length, 24);
  assert.notEqual(a, b, 'entropy sanity: two phrases must not collide');
});

test('an invalid strength is rejected', () => {
  for (const bad of [100, 127, 512, 0]) {
    assert.throws(() => mnemonicService.generateMnemonic({ strength: bad }));
  }
});

test('an invalid mnemonic is rejected: bad checksum, wrong length, unknown word', () => {
  const valid = SEP5_VECTORS[0].mnemonic;
  const words = valid.split(' ');

  const cases = {
    'bad checksum': [...words.slice(0, 11), 'zoo'].join(' '),
    'wrong word count': words.slice(0, 11).join(' '),
    'unknown word': [...words.slice(0, 11), 'notaword'].join(' '),
    empty: '',
  };

  for (const [label, bad] of Object.entries(cases)) {
    assert.equal(mnemonicService.validateMnemonic(bad), false, `${label} must not validate`);
    assert.throws(
      () => mnemonicService.deriveStellarKeypair({ mnemonic: bad }),
      (e) => e.code === mnemonicService.EXPORT_ERROR_CODES.INVALID_MNEMONIC,
      `${label} must throw invalid_mnemonic`,
    );
  }
});

test('an invalid-mnemonic error never echoes the phrase back', () => {
  const bad = 'illness spike retreat truth genius clock brain pass fit cave bargain zoo';
  try {
    mnemonicService.deriveStellarKeypair({ mnemonic: bad });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(!err.message.includes('illness'), 'the phrase must not appear in the error');
    assert.ok(!err.message.includes(bad));
  }
});

// ── Create vs recover ───────────────────────────────────────────────────

test('createMnemonicWallet returns a phrase that genuinely derives the new account', () => {
  const created = mnemonicService.createMnemonicWallet();

  assert.equal(created.mnemonicDerived, true);
  assert.equal(mnemonicService.validateMnemonic(created.mnemonic), true);

  const rederived = mnemonicService.deriveStellarKeypair({ mnemonic: created.mnemonic });
  assert.equal(rederived.publicKey, created.publicKey);
  assert.equal(rederived.secretKey, created.secretKey);
});

test('recovery succeeds only when derivation reproduces the stored public key', () => {
  const v = SEP5_VECTORS[0];
  const recovered = mnemonicService.recoverWalletFromMnemonic({
    mnemonic: v.mnemonic,
    expectedPublicKey: v.accounts[0][1],
  });
  assert.equal(recovered.publicKey, v.accounts[0][1]);
  assert.equal(recovered.accountIndex, 0);

  // A wallet at a non-zero index is still found by the scan.
  const atIndexTwo = mnemonicService.recoverWalletFromMnemonic({
    mnemonic: v.mnemonic,
    expectedPublicKey: v.accounts[2][1],
  });
  assert.equal(atIndexTwo.accountIndex, 2);
});

test('SAFETY: a phrase that derives a DIFFERENT account is refused, not adopted', () => {
  // This is the heart of the issue. "Recovery" that happily creates a new
  // account would tell the user they recovered a wallet they did not.
  const unrelated = mnemonicService.generateMnemonic();
  const victimPublicKey = SEP5_VECTORS[0].accounts[0][1];

  assert.throws(
    () => mnemonicService.recoverWalletFromMnemonic({
      mnemonic: unrelated, expectedPublicKey: victimPublicKey,
    }),
    (e) => e.code === mnemonicService.EXPORT_ERROR_CODES.MNEMONIC_MISMATCH,
  );

  assert.equal(
    mnemonicService.mnemonicControlsWallet({
      mnemonic: unrelated, publicKey: victimPublicKey,
    }),
    false,
  );
});

test('SAFETY: a random (legacy) keypair is controlled by no mnemonic', () => {
  // Keypair.random() is how every existing wallet was made. No phrase
  // reproduces it, and the module must say so rather than inventing one.
  const legacy = StellarSdk.Keypair.random();
  for (let i = 0; i < 5; i += 1) {
    const phrase = mnemonicService.generateMnemonic();
    assert.equal(
      mnemonicService.mnemonicControlsWallet({ mnemonic: phrase, publicKey: legacy.publicKey() }),
      false,
      'a freshly generated phrase must never claim to control a random keypair',
    );
  }
});

test('exportVerifiedMnemonic only returns a phrase it has proven controls the wallet', () => {
  const v = SEP5_VECTORS[0];
  const ok = mnemonicService.exportVerifiedMnemonic({
    mnemonic: v.mnemonic, publicKey: v.accounts[0][1],
  });
  assert.equal(ok.mnemonicAvailable, true);
  assert.equal(ok.publicKey, v.accounts[0][1]);
  assert.equal(ok.importFormat, 'bip39_mnemonic');

  assert.throws(
    () => mnemonicService.exportVerifiedMnemonic({
      mnemonic: mnemonicService.generateMnemonic(), publicKey: v.accounts[0][1],
    }),
    (e) => e.code === mnemonicService.EXPORT_ERROR_CODES.MNEMONIC_MISMATCH,
  );
});

// ── Export authorization harness ────────────────────────────────────────

const { hashPin } = require('../src/compliance/pin.service');

const REAL_PIN = '1357';
const LEGACY = StellarSdk.Keypair.random();

/** In-memory Prisma double with the grant state machine's constraints. */
const makePrisma = ({ pinHash = hashPin(REAL_PIN) } = {}) => {
  const state = {
    users: [{
      id: 'u1', pinHash, pinFailedAttempts: 0, pinLockedUntil: null, phoneNumber: '+2348000000001',
    }],
    wallets: [{
      id: 'w1',
      userId: 'u1',
      publicKey: LEGACY.publicKey(),
      encryptedSecretKey: 'enc::placeholder',
      phoneNumber: '+2348000000001',
    }],
    grants: [],
    auditRows: [],
  };

  let seq = 0;

  const client = {
    state,
    user: {
      findUnique: async ({ where }) => state.users.find((u) => u.id === where.id) || null,
      update: async ({ where, data }) => {
        const u = state.users.find((x) => x.id === where.id);
        Object.assign(u, data);
        return u;
      },
    },
    wallet: {
      findUnique: async ({ where }) => state.wallets.find((w) => w.id === where.id) || null,
    },
    mnemonicExportGrant: {
      create: async ({ data }) => {
        seq += 1;
        const row = { id: `g${seq}`, consumedAt: null, ...data };
        state.grants.push(row);
        return row;
      },
      findUnique: async ({ where }) => state.grants.find((g) => g.id === where.id) || null,
      update: async ({ where, data }) => {
        const g = state.grants.find((x) => x.id === where.id);
        Object.assign(g, data);
        return g;
      },
      // Conditional update — the single-use arbiter.
      updateMany: async ({ where, data }) => {
        const matches = state.grants.filter((g) => (
          g.id === where.id
          && (where.status === undefined || g.status === where.status)
          && (where.consumedAt === undefined || g.consumedAt === where.consumedAt)
        ));
        for (const g of matches) Object.assign(g, data);
        return { count: matches.length };
      },
    },
    auditLog: {
      create: async ({ data }) => { state.auditRows.push(data); return data; },
    },
  };

  return client;
};

/** Capture the challenge code the way the user's channel would receive it. */
const makeSender = () => {
  const sent = [];
  return { sent, sendChallenge: async (payload) => { sent.push(payload); } };
};

const authorizeFlow = async (prismaClient, sender) => {
  const grant = await mnemonicService.requestExport({
    userId: 'u1', walletId: 'w1', prismaClient, sendChallenge: sender.sendChallenge,
  });
  const { code } = sender.sent[0];
  await mnemonicService.verifyExportChallenge({
    grantId: grant.id, code, pin: REAL_PIN, prismaClient,
  });
  return grant;
};

// ── Two-factor enforcement ──────────────────────────────────────────────

test('requestExport stores only a HASH of the challenge, never the code', async () => {
  const prismaClient = makePrisma();
  const sender = makeSender();
  await mnemonicService.requestExport({
    userId: 'u1', walletId: 'w1', prismaClient, sendChallenge: sender.sendChallenge,
  });

  const { code } = sender.sent[0];
  assert.equal(code.length, mnemonicService.CHALLENGE_DIGITS);
  assert.match(code, /^\d+$/);

  const [row] = prismaClient.state.grants;
  assert.ok(!row.challengeHash.includes(code), 'the plaintext code must not be stored');
  assert.equal(row.status, mnemonicService.GRANT_STATUS.PENDING);
  assert.equal(JSON.stringify(row).includes(code), false);
});

test('both factors are required: the correct code with a WRONG PIN does not authorize', async () => {
  const prismaClient = makePrisma();
  const sender = makeSender();
  const grant = await mnemonicService.requestExport({
    userId: 'u1', walletId: 'w1', prismaClient, sendChallenge: sender.sendChallenge,
  });

  await assert.rejects(
    () => mnemonicService.verifyExportChallenge({
      grantId: grant.id, code: sender.sent[0].code, pin: '9999', prismaClient,
    }),
    (e) => e.code === mnemonicService.EXPORT_ERROR_CODES.PIN_REJECTED,
  );

  assert.equal(prismaClient.state.grants[0].status, mnemonicService.GRANT_STATUS.PENDING);
  await assert.rejects(
    () => mnemonicService.consumeExport({ grantId: grant.id, prismaClient }),
    (e) => e.code === mnemonicService.EXPORT_ERROR_CODES.NOT_AUTHORIZED,
  );
});

test('both factors are required: the correct PIN with a WRONG code does not authorize', async () => {
  const prismaClient = makePrisma();
  const sender = makeSender();
  const grant = await mnemonicService.requestExport({
    userId: 'u1', walletId: 'w1', prismaClient, sendChallenge: sender.sendChallenge,
  });

  await assert.rejects(
    () => mnemonicService.verifyExportChallenge({
      grantId: grant.id, code: '000000', pin: REAL_PIN, prismaClient,
    }),
    (e) => e.code === mnemonicService.EXPORT_ERROR_CODES.CHALLENGE_REJECTED,
  );

  assert.equal(prismaClient.state.grants[0].status, mnemonicService.GRANT_STATUS.PENDING);
  assert.equal(prismaClient.state.grants[0].challengeAttempts, 1, 'the attempt is counted');
});

test('a client-supplied "verified" flag cannot authorize an export', async () => {
  const prismaClient = makePrisma();
  const sender = makeSender();
  const grant = await mnemonicService.requestExport({
    userId: 'u1', walletId: 'w1', prismaClient, sendChallenge: sender.sendChallenge,
  });

  // Every shape a hopeful caller might try. Verified state lives only in the
  // grant row, so none of these are even read.
  for (const injected of [
    { verified: true }, { pinVerified: true, otpVerified: true },
    { status: 'authorized' }, { authorized: true },
  ]) {
    await assert.rejects(
      () => mnemonicService.consumeExport({ grantId: grant.id, prismaClient, ...injected }),
      (e) => e.code === mnemonicService.EXPORT_ERROR_CODES.NOT_AUTHORIZED,
      `${JSON.stringify(injected)} must not authorize`,
    );
  }
});

test('bounded attempts: exceeding the budget revokes the grant', async () => {
  const prismaClient = makePrisma();
  const sender = makeSender();
  const grant = await mnemonicService.requestExport({
    userId: 'u1', walletId: 'w1', prismaClient, sendChallenge: sender.sendChallenge,
  });

  for (let i = 0; i < mnemonicService.CHALLENGE_MAX_ATTEMPTS; i += 1) {
    await assert.rejects(() => mnemonicService.verifyExportChallenge({
      grantId: grant.id, code: '000000', pin: REAL_PIN, prismaClient,
    }));
  }

  await assert.rejects(
    () => mnemonicService.verifyExportChallenge({
      grantId: grant.id, code: sender.sent[0].code, pin: REAL_PIN, prismaClient,
    }),
    (e) => e.code === mnemonicService.EXPORT_ERROR_CODES.CHALLENGE_ATTEMPTS_EXCEEDED,
    'even the CORRECT code must fail once the budget is gone',
  );
  assert.equal(prismaClient.state.grants[0].status, mnemonicService.GRANT_STATUS.REVOKED);
});

test('an expired challenge cannot be verified', async () => {
  const prismaClient = makePrisma();
  const sender = makeSender();
  const grant = await mnemonicService.requestExport({
    userId: 'u1', walletId: 'w1', prismaClient, sendChallenge: sender.sendChallenge,
  });

  const later = new Date(Date.now() + mnemonicService.CHALLENGE_TTL_MS + 1000);
  await assert.rejects(
    () => mnemonicService.verifyExportChallenge({
      grantId: grant.id, code: sender.sent[0].code, pin: REAL_PIN, prismaClient, now: later,
    }),
    (e) => e.code === mnemonicService.EXPORT_ERROR_CODES.GRANT_EXPIRED,
  );
  assert.equal(prismaClient.state.grants[0].status, mnemonicService.GRANT_STATUS.EXPIRED);
});

test('an AUTHORIZED grant still expires before it is consumed', async () => {
  const prismaClient = makePrisma();
  const sender = makeSender();
  const grant = await authorizeFlow(prismaClient, sender);

  const later = new Date(Date.now() + mnemonicService.CHALLENGE_TTL_MS + 1000);
  await assert.rejects(
    () => mnemonicService.consumeExport({ grantId: grant.id, prismaClient, now: later }),
    (e) => e.code === mnemonicService.EXPORT_ERROR_CODES.GRANT_EXPIRED,
  );
});

// ── Single use / replay ─────────────────────────────────────────────────

test('ACCEPTANCE: an authorized export succeeds once and is then dead', async () => {
  const prismaClient = makePrisma();
  const sender = makeSender();
  const grant = await authorizeFlow(prismaClient, sender);

  const payload = await mnemonicService.consumeExport({
    grantId: grant.id, prismaClient, decryptSecret: () => LEGACY.secret(),
  });

  assert.equal(payload.secretKey, LEGACY.secret());
  assert.equal(prismaClient.state.grants[0].status, mnemonicService.GRANT_STATUS.CONSUMED);
  assert.ok(prismaClient.state.grants[0].consumedAt);

  await assert.rejects(
    () => mnemonicService.consumeExport({
      grantId: grant.id, prismaClient, decryptSecret: () => LEGACY.secret(),
    }),
    (e) => e.code === mnemonicService.EXPORT_ERROR_CODES.GRANT_CONSUMED,
  );
});

test('REPLAY: two CONCURRENT consumes yield exactly one export', async () => {
  const prismaClient = makePrisma();
  const sender = makeSender();
  const grant = await authorizeFlow(prismaClient, sender);

  const results = await Promise.allSettled([
    mnemonicService.consumeExport({ grantId: grant.id, prismaClient, decryptSecret: () => LEGACY.secret() }),
    mnemonicService.consumeExport({ grantId: grant.id, prismaClient, decryptSecret: () => LEGACY.secret() }),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one consume may succeed');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, mnemonicService.EXPORT_ERROR_CODES.GRANT_CONSUMED);
});

test('a used challenge code cannot be replayed on a fresh grant', async () => {
  const prismaClient = makePrisma();
  const sender = makeSender();
  const first = await authorizeFlow(prismaClient, sender);
  const usedCode = sender.sent[0].code;
  await mnemonicService.consumeExport({
    grantId: first.id, prismaClient, decryptSecret: () => LEGACY.secret(),
  });

  // A second request draws a new code; the old one is bound to the old grant
  // by its per-grant salt and cannot satisfy the new one.
  const second = await mnemonicService.requestExport({
    userId: 'u1', walletId: 'w1', prismaClient, sendChallenge: sender.sendChallenge,
  });
  const newCode = sender.sent[1].code;

  if (usedCode !== newCode) {
    await assert.rejects(
      () => mnemonicService.verifyExportChallenge({
        grantId: second.id, code: usedCode, pin: REAL_PIN, prismaClient,
      }),
      (e) => e.code === mnemonicService.EXPORT_ERROR_CODES.CHALLENGE_REJECTED,
    );
  }
});

test('a wallet belonging to another user cannot be exported', async () => {
  const prismaClient = makePrisma();
  const sender = makeSender();
  await assert.rejects(
    () => mnemonicService.requestExport({
      userId: 'intruder', walletId: 'w1', prismaClient, sendChallenge: sender.sendChallenge,
    }),
    (e) => e.code === mnemonicService.EXPORT_ERROR_CODES.WALLET_NOT_FOUND,
  );
  assert.equal(sender.sent.length, 0, 'no challenge is sent for a wallet you do not own');
});

// ── The legacy-wallet guarantee ─────────────────────────────────────────

test('SAFETY: exporting a legacy random-keypair wallet NEVER returns a mnemonic', async () => {
  const prismaClient = makePrisma();
  const sender = makeSender();
  const grant = await authorizeFlow(prismaClient, sender);

  const payload = await mnemonicService.consumeExport({
    grantId: grant.id, prismaClient, decryptSecret: () => LEGACY.secret(),
  });

  assert.equal(payload.mnemonicAvailable, false);
  assert.equal(payload.mnemonic, undefined, 'no fabricated phrase, ever');
  assert.equal(payload.importFormat, 'stellar_secret_seed');
  assert.match(payload.reason, /No mnemonic can reproduce it/);

  // The exported secret really is the wallet's key, so the export is useful.
  assert.equal(
    StellarSdk.Keypair.fromSecret(payload.secretKey).publicKey(),
    prismaClient.state.wallets[0].publicKey,
  );
});

// ── Audit and redaction ─────────────────────────────────────────────────

test('ACCEPTANCE: a completed export is written to the audit log', async () => {
  auditLog.length = 0;
  const prismaClient = makePrisma();
  const sender = makeSender();
  const grant = await authorizeFlow(prismaClient, sender);
  await mnemonicService.consumeExport({
    grantId: grant.id, prismaClient, decryptSecret: () => LEGACY.secret(),
  });

  const actions = auditLog.map((e) => e.action);
  assert.ok(actions.includes('wallet.export.requested'));
  assert.ok(actions.includes('wallet.export.completed'));

  const completed = auditLog.find((e) => e.action === 'wallet.export.completed');
  assert.equal(completed.entityType, 'Wallet');
  assert.equal(completed.entityId, 'w1');
  assert.equal(completed.actorId, 'u1');
});

test('REDACTION: no secret reaches the audit log, the grant row, or the logger', async () => {
  auditLog.length = 0;
  loggedLines.length = 0;
  const prismaClient = makePrisma();
  const sender = makeSender();
  const grant = await authorizeFlow(prismaClient, sender);
  const code = sender.sent[0].code;

  const payload = await mnemonicService.consumeExport({
    grantId: grant.id, prismaClient, decryptSecret: () => LEGACY.secret(),
  });

  const secrets = [payload.secretKey, LEGACY.secret(), code, REAL_PIN];
  const haystacks = {
    'audit log': JSON.stringify(auditLog),
    'grant rows': JSON.stringify(prismaClient.state.grants),
    'logger output': loggedLines.join('\n'),
    'audit rows': JSON.stringify(prismaClient.state.auditRows),
  };

  for (const [label, haystack] of Object.entries(haystacks)) {
    for (const secret of secrets) {
      assert.equal(
        haystack.includes(secret), false,
        `${label} must not contain the ${secret === code ? 'challenge code' : 'secret'}`,
      );
    }
    // Belt and braces: no Stellar secret seed shape anywhere.
    assert.equal(/S[A-Z2-7]{55}/.test(haystack), false, `${label} must contain no S... key`);
  }
});

test('REDACTION: a mnemonic never appears in any log line', () => {
  loggedLines.length = 0;
  const created = mnemonicService.createMnemonicWallet();
  const joined = loggedLines.join('\n');
  assert.equal(joined.includes(created.mnemonic), false);
  assert.equal(joined.includes(created.secretKey), false);
  // Creating a wallet should not log at all.
  assert.equal(loggedLines.length, 0);
});

test('REDACTION: export errors carry codes, not key material', async () => {
  const prismaClient = makePrisma();
  await assert.rejects(
    () => mnemonicService.consumeExport({ grantId: 'nope', prismaClient }),
    (err) => {
      assert.equal(err.code, mnemonicService.EXPORT_ERROR_CODES.GRANT_NOT_FOUND);
      assert.equal(/S[A-Z2-7]{55}/.test(err.message), false);
      return true;
    },
  );
});
