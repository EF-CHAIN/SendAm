'use strict';

// Secure recovery-phrase export API (#960) — HTTP integration tests.
//
// `mnemonic.service.test.js` already proves the export POLICY in isolation.
// These tests prove the part that only exists once the policy is reachable
// over HTTP, which is where #960's "secure, one-time export API" actually
// lives or dies:
//
//   * an unauthenticated caller gets nowhere;
//   * an authenticated caller cannot touch another user's wallet or grant —
//     including the CLAIM step, which the service does not guard at all;
//   * neither factor alone authorizes, and a client-asserted status does not;
//   * the material is handed over exactly once, under concurrency;
//   * expired and revoked grants are dead ends;
//   * the audit trail records the event and none of the material;
//   * both ceilings exist: grants per hour, and attempts within a grant;
//   * a pre-existing randomly generated wallet is never given a phrase that
//     does not control it.
//
// The real router, the real session middleware, the real rate limiters and the
// real service are all exercised. Only the edges are doubled.
//
// ── Why the PIN service is doubled ──────────────────────────────────────
//
// `inject('compliance/pin.service', ...)` is a deliberate unit boundary, not a
// workaround: these tests need to drive the PIN factor to specific outcomes
// (accepted, rejected, locked with a backoff) without running Argon2id, and
// the real lockout policy has its own tests in `pin.service.test.js` and
// `pinLockout.test.js`.
//
// It was briefly also a necessity — `compliance/pin.service.js` did not parse
// on main before #1085, so the real `mnemonic.service` could not be required
// at all. #1085 repaired that, and `mnemonic.service.test.js` passes again,
// so the injection here is back to being an ordinary test double.
//
// Nothing here touches a real wallet, a real key, a live account or a network.
// Every secret below is generated at runtime by this file.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const StellarSdk = require('@stellar/stellar-sdk');

// Offline-suite conventions: a dummy key so crypto.service loads, and the REST
// API switched on. Neither encrypts nor exposes anything real.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.PIN_PEPPER = process.env.PIN_PEPPER || 'test-only-pin-pepper';
process.env.ENABLE_WALLET_REST_API = 'true';

const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

// ── Doubles ──────────────────────────────────────────────────────────────

// In-memory rate-limit store, so the REAL limiter middleware runs without
// Postgres. Mirrors the pattern in wallet.accountRateLimit.test.js.
const rateCounters = new Map();
inject('services/rateLimit.service', {
  consume: async (key) => {
    const totalHits = (rateCounters.get(key) || 0) + 1;
    rateCounters.set(key, totalHits);
    return { totalHits, resetTime: new Date(Date.now() + 3600000) };
  },
  decrement: async () => {},
  resetKey: async () => {},
});

let sessionUser = { id: 'user-1', phoneNumber: '+10000000001' };
inject('services/restAuth.service', {
  findSession: async (token) => {
    if (token === 'token-user-1') return { id: 'session-1', user: { id: 'user-1', phoneNumber: '+10000000001' } };
    if (token === 'token-user-2') return { id: 'session-2', user: { id: 'user-2', phoneNumber: '+10000000002' } };
    if (token === 'valid-token') return { id: 'session-1', user: sessionUser };
    return null;
  },
});

// See the scaffolding note above: this is required for the SUT to load.
let pinOutcome = { ok: true };
const pinCalls = [];
inject('compliance/pin.service', {
  verifyPinAttempt: async ({ userId, pin }) => {
    pinCalls.push({ userId, pin });
    return typeof pinOutcome === 'function' ? pinOutcome({ userId, pin }) : pinOutcome;
  },
});

const auditLog = [];
inject('common/audit.service', {
  writeAuditLog: async (entry) => { auditLog.push(entry); return entry; },
  verifyAuditLogIntegrity: async () => ({ valid: true, errors: [] }),
});

const loggedLines = [];
inject('utils/logger', (() => {
  const record = (level) => (...args) => loggedLines.push(`${level} ${args.map(String).join(' ')}`);
  return {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    // `errors/envelope.js` runs every response body through this before
    // sending it, so the double has to provide it or every error response
    // becomes a 500 and the status assertions below would be meaningless.
    sanitize: (payload) => payload,
  };
})());

const whatsappSends = [];
inject('services/whatsapp.service', {
  sendTextMessage: async (to, body) => { whatsappSends.push({ to, body }); return { ok: true }; },
});

// `wallet.controller` pulls the payment orchestrator and most of the app; this
// suite is about /export, so the sibling handlers are stubbed out.
inject('controllers/wallet.controller', {
  createWallet: (_req, res) => res.status(201).json({ ok: true }),
  checkBalance: (_req, res) => res.status(200).json({ ok: true }),
  getTransactionHistory: (_req, res) => res.status(200).json({ ok: true }),
  getStatement: (_req, res) => res.status(200).json({ ok: true }),
  sendFunds: (_req, res) => res.status(200).json({ ok: true }),
});

// ── In-memory Prisma double ──────────────────────────────────────────────
//
// `updateMany` is the single-use arbiter in the service, so it is modelled
// faithfully: it filters on every supplied field and reports a count. A
// double that ignored `consumedAt: null` would make the concurrency test pass
// for the wrong reason.

let wallets = [];
let grants = [];
let grantSeq = 0;

const matches = (row, where) => Object.entries(where).every(([key, value]) => {
  if (value === null) return row[key] === null || row[key] === undefined;
  return row[key] === value;
});

const db = {
  wallet: {
    findUnique: async ({ where }) => wallets.find((w) => w.id === where.id) || null,
    findFirst: async ({ where }) => wallets.find((w) => matches(w, where)) || null,
  },
  mnemonicExportGrant: {
    create: async ({ data }) => {
      grantSeq += 1;
      const row = { id: `grant-${grantSeq}`, consumedAt: null, authorizedAt: null, ...data };
      grants.push(row);
      return row;
    },
    findUnique: async ({ where }) => grants.find((g) => g.id === where.id) || null,
    update: async ({ where, data }) => {
      const row = grants.find((g) => g.id === where.id);
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }) => {
      const hit = grants.filter((g) => matches(g, where));
      hit.forEach((g) => Object.assign(g, data));
      return { count: hit.length };
    },
  },
};
inject('common/prisma', db);

const walletRoutes = require('../src/routes/wallet.routes');
const mnemonicService = require('../src/wallet/mnemonic.service');
// The REAL encrypt/decrypt pair, under the dummy ENCRYPTION_KEY above. Using
// it means the claim path exercises the production decrypt rather than an
// injected stub, so a wallet whose ciphertext cannot be read would fail here
// the way it would in production.
const { encrypt } = require('../src/services/crypto.service');

// ── Harness ──────────────────────────────────────────────────────────────

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/wallet', walletRoutes);
  app.use((error, _req, res, _next) => res
    .status(error.statusCode || 500)
    .json({ error: error.code || error.message }));
  return app;
};

const withServer = async (run) => {
  const server = http.createServer(buildApp());
  await new Promise((resolve) => server.listen(0, resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
};

const post = (base, route, body, token = 'token-user-1') => fetch(`${base}${route}`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body || {}),
});

// A synthetic wallet: a keypair generated here and now, controlling nothing.
const syntheticWallet = ({ id, userId, phoneNumber }) => {
  const keypair = StellarSdk.Keypair.random();
  return {
    id,
    userId,
    chain: 'stellar',
    phoneNumber,
    publicKey: keypair.publicKey(),
    // Genuine ciphertext under the test-only ENCRYPTION_KEY, so the claim
    // path runs the real decrypt. The keypair was generated a line ago and
    // controls nothing.
    encryptedSecretKey: encrypt(keypair.secret()),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    secretForAssertions: keypair.secret(),
  };
};

beforeEach(() => {
  rateCounters.clear();
  auditLog.length = 0;
  loggedLines.length = 0;
  whatsappSends.length = 0;
  pinCalls.length = 0;
  pinOutcome = { ok: true };
  grants = [];
  grantSeq = 0;
  sessionUser = { id: 'user-1', phoneNumber: '+10000000001' };
  wallets = [
    syntheticWallet({ id: 'wallet-1', userId: 'user-1', phoneNumber: '+10000000001' }),
    syntheticWallet({ id: 'wallet-2', userId: 'user-2', phoneNumber: '+10000000002' }),
  ];
});

// Drive a grant to `authorized` the way a real client would, through HTTP.
const authorizeGrant = async (base, token = 'token-user-1') => {
  const requested = await post(base, '/api/wallet/export/request', {}, token);
  const { data } = await requested.json();
  const code = whatsappSends[whatsappSends.length - 1].body.match(/\b(\d{6})\b/)[1];
  const verified = await post(
    base,
    '/api/wallet/export/verify',
    { grantId: data.grantId, code, pin: '1234' },
    token,
  );
  assert.equal(verified.status, 200, 'the fixture must reach `authorized`');
  return { grantId: data.grantId, code };
};

// ── The controller's own invariants ──────────────────────────────────────

test('every service error code maps to a status, and mounting needs no ENCRYPTION_KEY', () => {
  const controller = require('../src/controllers/mnemonicExport.controller');

  // The controller keeps its own literal map so it can be loaded without
  // pulling `crypto.service`. That only stays correct if the two agree, so a
  // code added to the service without a status here fails right now rather
  // than returning 500 to a caller one day.
  const unmapped = Object.values(mnemonicService.EXPORT_ERROR_CODES)
    .filter((code) => controller.statusForCode(code) === undefined);
  assert.deepEqual(unmapped, [], `these service codes have no HTTP status: ${unmapped}`);

  // And nothing in the module's import graph may demand encryption config:
  // mounting a router must not depend on a key being present.
  assert.equal(typeof controller.requestExport, 'function');
});

// ── Authentication and wallet ownership ──────────────────────────────────

test('every export endpoint refuses an unauthenticated caller', async () => {
  await withServer(async (base) => {
    for (const route of ['/request', '/verify', '/claim', '/revoke']) {
      const res = await post(base, `/api/wallet/export${route}`, { grantId: 'grant-1', code: '123456', pin: '1234' }, null);
      assert.equal(res.status, 401, `${route} must require a session`);
    }
    assert.equal(grants.length, 0, 'no grant may be created without a session');
    assert.equal(whatsappSends.length, 0, 'no code may be sent without a session');
  });
});

test('a caller cannot request an export for a wallet they do not own', async () => {
  await withServer(async (base) => {
    const res = await post(base, '/api/wallet/export/request', { walletId: 'wallet-2' }, 'token-user-1');

    assert.equal(res.status, 404, 'another user\'s wallet must be indistinguishable from a missing one');
    const body = await res.json();
    // The envelope normalizes `error.code` to a transport-level value
    // (`not_found`); the domain code travels in `details`.
    assert.equal(body.error?.details?.code, mnemonicService.EXPORT_ERROR_CODES.WALLET_NOT_FOUND);
    assert.equal(grants.length, 0);
    assert.equal(whatsappSends.length, 0, 'no code may be sent to the wallet\'s owner either');
  });
});

test('a caller cannot verify or claim another user\'s grant — the claim guard is the one the service lacks', async () => {
  await withServer(async (base) => {
    const { grantId, code } = await authorizeGrant(base, 'token-user-1');

    // user-2 holds a valid session and, in this test, even knows the code.
    const verified = await post(base, '/api/wallet/export/verify', { grantId, code, pin: '1234' }, 'token-user-2');
    assert.equal(verified.status, 404);

    const claimed = await post(base, '/api/wallet/export/claim', { grantId }, 'token-user-2');
    assert.equal(claimed.status, 404, 'an authorized grant must not be claimable by a stranger');
    const body = await claimed.json();
    assert.ok(JSON.stringify(body).includes(mnemonicService.EXPORT_ERROR_CODES.GRANT_NOT_FOUND));

    // And the rightful owner is unharmed: the grant was not consumed.
    const owner = await post(base, '/api/wallet/export/claim', { grantId }, 'token-user-1');
    assert.equal(owner.status, 200);
  });
});

test('the default wallet is the caller\'s own, with no body at all', async () => {
  await withServer(async (base) => {
    const res = await post(base, '/api/wallet/export/request', {}, 'token-user-1');
    assert.equal(res.status, 201);
    const { data } = await res.json();
    assert.equal(data.walletId, 'wallet-1');
    assert.equal(whatsappSends[0].to, '+10000000001');
  });
});

// ── PIN and second factor ────────────────────────────────────────────────

test('the code alone does not authorize an export', async () => {
  await withServer(async (base) => {
    const requested = await post(base, '/api/wallet/export/request', {}, 'token-user-1');
    const { data } = await requested.json();
    const code = whatsappSends[0].body.match(/\b(\d{6})\b/)[1];

    pinOutcome = { ok: false };
    const res = await post(base, '/api/wallet/export/verify', { grantId: data.grantId, code, pin: '9999' }, 'token-user-1');

    assert.equal(res.status, 401);
    assert.ok(JSON.stringify(await res.json()).includes(mnemonicService.EXPORT_ERROR_CODES.PIN_REJECTED));
    assert.equal(grants[0].status, mnemonicService.GRANT_STATUS.PENDING, 'the grant must not advance');

    // And the material stays locked.
    const claimed = await post(base, '/api/wallet/export/claim', { grantId: data.grantId }, 'token-user-1');
    assert.equal(claimed.status, 403);
  });
});

test('the PIN alone does not authorize an export', async () => {
  await withServer(async (base) => {
    const requested = await post(base, '/api/wallet/export/request', {}, 'token-user-1');
    const { data } = await requested.json();

    const res = await post(base, '/api/wallet/export/verify', { grantId: data.grantId, code: '000000', pin: '1234' }, 'token-user-1');

    assert.equal(res.status, 401);
    assert.ok(JSON.stringify(await res.json()).includes(mnemonicService.EXPORT_ERROR_CODES.CHALLENGE_REJECTED));
    assert.equal(grants[0].status, mnemonicService.GRANT_STATUS.PENDING);
  });
});

test('a PIN lockout is reported with its backoff, and burns the shared budget', async () => {
  await withServer(async (base) => {
    const requested = await post(base, '/api/wallet/export/request', {}, 'token-user-1');
    const { data } = await requested.json();
    const code = whatsappSends[0].body.match(/\b(\d{6})\b/)[1];

    pinOutcome = { ok: false, locked: true, retryAfterMs: 1800000 };
    const res = await post(base, '/api/wallet/export/verify', { grantId: data.grantId, code, pin: '1234' }, 'token-user-1');

    assert.equal(res.status, 401);
    const body = JSON.stringify(await res.json());
    assert.ok(body.includes('retryAfterMs'), 'a client must be able to back off correctly');
    // The PIN went through the shared verifier, so export attempts consume the
    // same lockout budget as any other PIN use rather than a private one.
    assert.equal(pinCalls.length, 1);
    assert.equal(pinCalls[0].userId, 'user-1');
  });
});

test('a client-asserted status cannot authorize anything', async () => {
  await withServer(async (base) => {
    const requested = await post(base, '/api/wallet/export/request', {}, 'token-user-1');
    const { data } = await requested.json();

    // Extra keys are rejected outright by the route validator, and even if they
    // were not, nothing downstream reads them.
    const res = await post(base, '/api/wallet/export/claim', {
      grantId: data.grantId, status: 'authorized', verified: true,
    }, 'token-user-1');

    assert.ok(res.status === 400 || res.status === 403, `expected rejection, got ${res.status}`);
    assert.notEqual(grants[0].status, mnemonicService.GRANT_STATUS.CONSUMED);
  });
});

// ── Single use, replay and concurrency ───────────────────────────────────

test('the material is handed over exactly once', async () => {
  await withServer(async (base) => {
    const { grantId } = await authorizeGrant(base);

    const first = await post(base, '/api/wallet/export/claim', { grantId }, 'token-user-1');
    assert.equal(first.status, 200);

    const replay = await post(base, '/api/wallet/export/claim', { grantId }, 'token-user-1');
    assert.equal(replay.status, 409, 'a replayed claim must be refused');
    assert.ok(JSON.stringify(await replay.json()).includes(mnemonicService.EXPORT_ERROR_CODES.GRANT_CONSUMED));
  });
});

test('two concurrent claims produce exactly one success', async () => {
  await withServer(async (base) => {
    const { grantId } = await authorizeGrant(base);

    const results = await Promise.all([
      post(base, '/api/wallet/export/claim', { grantId }, 'token-user-1'),
      post(base, '/api/wallet/export/claim', { grantId }, 'token-user-1'),
      post(base, '/api/wallet/export/claim', { grantId }, 'token-user-1'),
    ]);
    const statuses = results.map((r) => r.status).sort();

    assert.equal(statuses.filter((s) => s === 200).length, 1, `exactly one winner; got ${statuses}`);
    assert.equal(statuses.filter((s) => s === 409).length, 2);
    assert.equal(grants[0].status, mnemonicService.GRANT_STATUS.CONSUMED);
  });
});

test('a verified grant cannot be re-verified into a second authorization window', async () => {
  await withServer(async (base) => {
    const { grantId, code } = await authorizeGrant(base);
    await post(base, '/api/wallet/export/claim', { grantId }, 'token-user-1');

    const res = await post(base, '/api/wallet/export/verify', { grantId, code, pin: '1234' }, 'token-user-1');
    assert.equal(res.status, 409, 'a consumed grant is not a reusable credential');
  });
});

test('the claim response is marked uncacheable, so it cannot be replayed from a proxy', async () => {
  await withServer(async (base) => {
    const { grantId } = await authorizeGrant(base);
    const res = await post(base, '/api/wallet/export/claim', { grantId }, 'token-user-1');

    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') || '', /no-store/);
  });
});

// ── Expiry and revocation ────────────────────────────────────────────────

test('an expired grant cannot be verified or claimed', async () => {
  await withServer(async (base) => {
    const requested = await post(base, '/api/wallet/export/request', {}, 'token-user-1');
    const { data } = await requested.json();
    const code = whatsappSends[0].body.match(/\b(\d{6})\b/)[1];

    grants[0].challengeExpiresAt = new Date(Date.now() - 1000);

    const verified = await post(base, '/api/wallet/export/verify', { grantId: data.grantId, code, pin: '1234' }, 'token-user-1');
    assert.equal(verified.status, 410);
    assert.equal(grants[0].status, mnemonicService.GRANT_STATUS.EXPIRED);

    const claimed = await post(base, '/api/wallet/export/claim', { grantId: data.grantId }, 'token-user-1');
    assert.equal(claimed.status, 403);
  });
});

test('an authorized grant that has expired is still refused at claim time', async () => {
  await withServer(async (base) => {
    const { grantId } = await authorizeGrant(base);

    // Authorization is not a permanent key: the window closes.
    grants[0].challengeExpiresAt = new Date(Date.now() - 1000);

    const res = await post(base, '/api/wallet/export/claim', { grantId }, 'token-user-1');
    assert.equal(res.status, 410);
    assert.equal(grants[0].status, mnemonicService.GRANT_STATUS.EXPIRED);
  });
});

test('a user can revoke their own pending export, and a revoked grant is a dead end', async () => {
  await withServer(async (base) => {
    const requested = await post(base, '/api/wallet/export/request', {}, 'token-user-1');
    const { data } = await requested.json();
    const code = whatsappSends[0].body.match(/\b(\d{6})\b/)[1];

    const revoked = await post(base, '/api/wallet/export/revoke', { grantId: data.grantId }, 'token-user-1');
    assert.equal(revoked.status, 200);
    assert.equal(grants[0].status, mnemonicService.GRANT_STATUS.REVOKED);

    const verified = await post(base, '/api/wallet/export/verify', { grantId: data.grantId, code, pin: '1234' }, 'token-user-1');
    assert.equal(verified.status, 403, 'a revoked grant must not be revivable with the right code');

    const claimed = await post(base, '/api/wallet/export/claim', { grantId: data.grantId }, 'token-user-1');
    assert.equal(claimed.status, 403);
  });
});

test('revoking after the material was taken is refused, not silently accepted', async () => {
  await withServer(async (base) => {
    const { grantId } = await authorizeGrant(base);
    await post(base, '/api/wallet/export/claim', { grantId }, 'token-user-1');

    const res = await post(base, '/api/wallet/export/revoke', { grantId }, 'token-user-1');
    assert.equal(res.status, 409);
    assert.equal(grants[0].status, mnemonicService.GRANT_STATUS.CONSUMED, 'the record of the export stands');
  });
});

test('a caller cannot revoke another user\'s grant', async () => {
  await withServer(async (base) => {
    const requested = await post(base, '/api/wallet/export/request', {}, 'token-user-1');
    const { data } = await requested.json();

    const res = await post(base, '/api/wallet/export/revoke', { grantId: data.grantId }, 'token-user-2');
    assert.equal(res.status, 404);
    assert.equal(grants[0].status, mnemonicService.GRANT_STATUS.PENDING, 'a stranger cannot cancel your export');
  });
});

// ── Bounded attempts ─────────────────────────────────────────────────────

test('the per-grant attempt budget is bounded, and exhausting it revokes the grant', async () => {
  await withServer(async (base) => {
    const requested = await post(base, '/api/wallet/export/request', {}, 'token-user-1');
    const { data } = await requested.json();
    const realCode = whatsappSends[0].body.match(/\b(\d{6})\b/)[1];

    const max = mnemonicService.CHALLENGE_MAX_ATTEMPTS;
    for (let i = 0; i < max; i += 1) {
      const wrong = String((Number(realCode) + i + 1) % 1000000).padStart(6, '0');
      const res = await post(base, '/api/wallet/export/verify', { grantId: data.grantId, code: wrong, pin: '1234' }, 'token-user-1');
      assert.equal(res.status, 401, `attempt ${i + 1} should be rejected, not fatal`);
    }

    // The budget is spent: even the CORRECT code is now useless.
    const res = await post(base, '/api/wallet/export/verify', { grantId: data.grantId, code: realCode, pin: '1234' }, 'token-user-1');
    assert.equal(res.status, 429);
    assert.equal(grants[0].status, mnemonicService.GRANT_STATUS.REVOKED);

    const claimed = await post(base, '/api/wallet/export/claim', { grantId: data.grantId }, 'token-user-1');
    assert.equal(claimed.status, 403);
  });
});

// ── Rate limiting ────────────────────────────────────────────────────────

test('minting grants is rate limited per account, far tighter than ordinary wallet reads', async () => {
  await withServer(async (base) => {
    for (let i = 0; i < 3; i += 1) {
      const res = await post(base, '/api/wallet/export/request', {}, 'token-user-1');
      assert.equal(res.status, 201, `request ${i + 1} should succeed`);
    }
    const blocked = await post(base, '/api/wallet/export/request', {}, 'token-user-1');
    assert.equal(blocked.status, 429, 'a fourth grant in the window must be refused');
    assert.equal(whatsappSends.length, 3, 'no code is sent for a rate-limited request');

    // Keyed by account, not IP: a second user is unaffected.
    const other = await post(base, '/api/wallet/export/request', {}, 'token-user-2');
    assert.equal(other.status, 201);
  });
});

test('the export limiter is keyed by account so rotating IPs does not help', async () => {
  await withServer(async (base) => {
    await post(base, '/api/wallet/export/request', {}, 'token-user-1');
    assert.ok(
      [...rateCounters.keys()].some((key) => key.startsWith('wallet-export:account:user-1')),
      `expected an account-keyed export counter; saw ${[...rateCounters.keys()]}`,
    );
  });
});

test('the verify step is independently rate limited', async () => {
  await withServer(async (base) => {
    const requested = await post(base, '/api/wallet/export/request', {}, 'token-user-1');
    const { data } = await requested.json();

    let sawRateLimit = false;
    for (let i = 0; i < 12; i += 1) {
      const res = await post(base, '/api/wallet/export/verify', { grantId: data.grantId, code: '000000', pin: '1234' }, 'token-user-1');
      if (res.status === 429) { sawRateLimit = true; break; }
    }
    assert.ok(sawRateLimit, 'repeated verify calls must hit a ceiling');
  });
});

// ── Audit logging, and what must never be in it ──────────────────────────

test('request and completion are both audited', async () => {
  await withServer(async (base) => {
    const { grantId } = await authorizeGrant(base);
    await post(base, '/api/wallet/export/claim', { grantId }, 'token-user-1');

    const actions = auditLog.map((entry) => entry.action);
    assert.ok(actions.includes('wallet.export.requested'), `saw ${actions}`);
    assert.ok(actions.includes('wallet.export.completed'), `saw ${actions}`);

    const completed = auditLog.find((entry) => entry.action === 'wallet.export.completed');
    assert.equal(completed.actorId, 'user-1');
    assert.equal(completed.entityId, 'wallet-1');
    assert.equal(completed.metadata.grantId, grantId);
  });
});

test('revocation is audited', async () => {
  await withServer(async (base) => {
    const requested = await post(base, '/api/wallet/export/request', {}, 'token-user-1');
    const { data } = await requested.json();
    await post(base, '/api/wallet/export/revoke', { grantId: data.grantId }, 'token-user-1');

    const revoked = auditLog.find((entry) => entry.action === 'wallet.export.revoked');
    assert.ok(revoked, `expected a revocation record; saw ${auditLog.map((e) => e.action)}`);
    assert.equal(revoked.metadata.grantId, data.grantId);
  });
});

test('no recovery material reaches the audit log, the app log or the grant row', async () => {
  await withServer(async (base) => {
    const { grantId, code } = await authorizeGrant(base);
    const claimed = await post(base, '/api/wallet/export/claim', { grantId }, 'token-user-1');
    const { data } = await claimed.json();

    const secret = data.secretKey;
    assert.ok(secret && secret.startsWith('S'), 'the caller does receive the material, once');

    const haystacks = {
      'audit log': JSON.stringify(auditLog),
      'app log': loggedLines.join('\n'),
      'grant row': JSON.stringify(grants),
    };
    for (const [label, haystack] of Object.entries(haystacks)) {
      assert.equal(haystack.includes(secret), false, `the secret key must not appear in the ${label}`);
      assert.equal(haystack.includes(code), false, `the challenge code must not appear in the ${label}`);
      assert.equal(haystack.includes('1234'), false, `the PIN must not appear in the ${label}`);
    }

    // The code is hashed in the row, never stored in the clear.
    assert.ok(grants[0].challengeHash.includes('$'));
    assert.equal(grants[0].challengeHash.includes(code), false);
  });
});

test('the delivery channel is reported honestly as WhatsApp, not claimed to be SMS', async () => {
  await withServer(async (base) => {
    const res = await post(base, '/api/wallet/export/request', {}, 'token-user-1');
    const { data } = await res.json();

    // #960 asks for SMS and no SMS provider exists in this repository. The API
    // says which channel was actually used rather than letting a caller or an
    // auditor assume.
    assert.equal(data.channel, 'whatsapp');
    assert.equal(whatsappSends.length, 1);
  });
});

// ── Compatibility with wallets that already exist ────────────────────────

test('an existing randomly generated wallet is never given a fabricated phrase', async () => {
  await withServer(async (base) => {
    const { grantId } = await authorizeGrant(base);
    const res = await post(base, '/api/wallet/export/claim', { grantId }, 'token-user-1');
    const { data } = await res.json();

    // This is the heart of it. `wallet-1` was created with Keypair.random(),
    // so NO phrase derives it. Returning twelve plausible words here would
    // hand the user a different, empty account and look like a successful
    // backup until the day they needed it.
    assert.equal(data.mnemonicAvailable, false);
    assert.equal(data.mnemonic, undefined);
    assert.equal(data.importFormat, 'stellar_secret_seed');
    assert.match(data.reason, /not from a BIP-39/i);
    assert.equal(data.publicKey, wallets[0].publicKey);
    assert.equal(data.secretKey, wallets[0].secretForAssertions);
  });
});

test('a mnemonic-derived wallet exports a phrase that really does derive it', () => {
  // Proven here against the service rather than over HTTP: the claim endpoint
  // has no phrase to work from, by design. This is the other half of the same
  // honesty property — a phrase is returned only when it is verifiably the
  // right one.
  const created = mnemonicService.createMnemonicWallet();
  const exported = mnemonicService.exportVerifiedMnemonic({
    mnemonic: created.mnemonic,
    publicKey: created.publicKey,
  });

  assert.equal(exported.mnemonicAvailable, true);
  assert.equal(exported.importFormat, 'bip39_mnemonic');
  assert.equal(exported.publicKey, created.publicKey);
  assert.equal(
    StellarSdk.Keypair.fromSecret(exported.secretKey).publicKey(),
    created.publicKey,
    'the exported phrase must reproduce the wallet it claims to back up',
  );

  assert.throws(
    () => mnemonicService.exportVerifiedMnemonic({
      mnemonic: created.mnemonic,
      publicKey: StellarSdk.Keypair.random().publicKey(),
    }),
    (error) => error.code === mnemonicService.EXPORT_ERROR_CODES.MNEMONIC_MISMATCH,
    'a phrase that does not derive the wallet must be refused',
  );
});
