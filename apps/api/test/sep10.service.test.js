'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const StellarSdk = require('@stellar/stellar-sdk');

const serverKeypair = StellarSdk.Keypair.random();
const clientKeypair = StellarSdk.Keypair.random();
const walletDomainKeypair = StellarSdk.Keypair.random();
const attackerKeypair = StellarSdk.Keypair.random();

const challengeRows = new Map();
const restSessions = new Map();
const redisMap = new Map();
const redisOps = [];

const fakeRedis = {
  set: async (key, value, mode, ttl) => {
    redisOps.push({ op: 'set', key, mode, ttl });
    redisMap.set(key, {
      value: String(value),
      ttl: Number(ttl),
      expiresAt: Date.now() + Number(ttl || 60) * 1000,
    });
    return 'OK';
  },
  get: async (key) => {
    redisOps.push({ op: 'get', key });
    const entry = redisMap.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      redisMap.delete(key);
      return null;
    }
    return entry.value;
  },
  del: async (key) => {
    redisOps.push({ op: 'del', key });
    redisMap.delete(key);
    return 1;
  },
};

const linkedUser = { id: 'user-sep10-1', phoneNumber: '+2348011112222' };

const mockPrisma = {
  sep10Challenge: {
    create: async ({ data }) => {
      const row = { ...data, consumedAt: null };
      challengeRows.set(data.challengeHash, row);
      return row;
    },
    updateMany: async ({ where, data }) => {
      const row = challengeRows.get(where.challengeHash);
      if (
        !row
        || row.account !== where.account
        || row.consumedAt !== null
        || row.expiresAt <= new Date()
      ) {
        return { count: 0 };
      }
      Object.assign(row, data);
      return { count: 1 };
    },
  },
  wallet: {
    findFirst: async ({ where }) => {
      if (where.publicKey === clientKeypair.publicKey() && where.network === 'testnet') {
        return { id: 'wallet-1', userId: linkedUser.id, publicKey: clientKeypair.publicKey(), user: linkedUser };
      }
      return null;
    },
  },
  restSession: {
    create: async ({ data }) => {
      restSessions.set(data.tokenHash, { id: `sess-${restSessions.size + 1}`, ...data, revokedAt: null });
    },
    findUnique: async ({ where }) => restSessions.get(where.tokenHash) || null,
    updateMany: async ({ where, data }) => {
      const row = restSessions.get(where.tokenHash);
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  },
  $transaction: async (fn) => fn(mockPrisma),
};

const mockConfig = {
  stellar: {
    network: 'testnet',
    networkPassphrase: StellarSdk.Networks.TESTNET,
    auth: {
      signingKey: serverKeypair.secret(),
      homeDomain: 'sendam.io',
      allowedHomeDomains: ['sendam.io', 'app.sendam.io'],
      webAuthDomain: 'api.sendam.io',
      challengeTtlSeconds: 300,
      sessionTtlMinutes: 15,
      jwtSecret: 'sep10-test-jwt-secret-key-0123456789abcdef',
    },
  },
};

const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

inject('common/prisma', mockPrisma);
inject('config/stellar', { StellarSdk });
inject('config/env', mockConfig);
inject('config/redis', { getRedisConnection: () => fakeRedis });
inject('common/audit.service', { writeAuditLog: async () => null });
inject('services/rateLimit.service', {
  consume: async () => ({ totalHits: 1, resetTime: new Date(Date.now() + 60000) }),
  decrement: async () => {},
  resetKey: async () => {},
});

const sep10 = require('../src/services/sep10.service');
const authRoutes = require('../src/routes/auth.routes');

const withServer = async (run) => {
  const app = express();
  app.use('/auth', authRoutes);
  app.use('/api/auth', authRoutes);
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, resolve));
  try {
    await run(`http://127.0.0.1:${srv.address().port}`);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
};

beforeEach(() => {
  challengeRows.clear();
  restSessions.clear();
  redisMap.clear();
  redisOps.length = 0;
  sep10.clearMemoryStores();
});

describe('SEP-10 Web Authentication Service & Routes (#942, #943)', () => {
  test('issues a valid SEP-10 challenge, verifies client signature, mints JWT, and stores token hash in Redis with TTL', async () => {
    const challenge = await sep10.createChallenge({
      account: clientKeypair.publicKey(),
      home_domain: 'sendam.io',
    });

    assert.ok(challenge.transaction);
    assert.equal(challenge.network_passphrase, StellarSdk.Networks.TESTNET);
    assert.equal(challenge.homeDomain, 'sendam.io');

    const tx = new StellarSdk.Transaction(challenge.transaction, StellarSdk.Networks.TESTNET);
    tx.sign(clientKeypair);
    const signedXdr = tx.toEnvelope().toXDR('base64');

    const verified = await sep10.verifyChallenge({ transaction: signedXdr });
    assert.ok(verified.token);
    assert.equal(verified.account, clientKeypair.publicKey());
    assert.equal(verified.homeDomain, 'sendam.io');
    assert.equal(verified.user.id, linkedUser.id);

    // Token is a valid 3-part JWT with standard SEP-10 claims
    const decoded = sep10.verifyJwtSignature(verified.token, mockConfig.stellar.auth.jwtSecret);
    assert.equal(decoded.sub, clientKeypair.publicKey());
    assert.equal(decoded.iss, 'https://api.sendam.io/auth');
    assert.equal(decoded.home_domain, 'sendam.io');
    assert.ok(decoded.exp > decoded.iat);

    // Token hash was stored in Redis with TTL
    const tokenRedisKey = `${sep10.TOKEN_KEY_PREFIX}${verified.tokenHash}`;
    assert.ok(redisMap.has(tokenRedisKey));
    assert.equal(redisMap.get(tokenRedisKey).ttl, 900);

    // Token passes live verification
    const tokenCheck = await sep10.verifyToken(verified.token);
    assert.equal(tokenCheck.valid, true);
    assert.equal(tokenCheck.account, clientKeypair.publicKey());
  });

  test('enforces single-use replay protection on signed challenges', async () => {
    const { transaction } = await sep10.createChallenge(clientKeypair.publicKey());
    const tx = new StellarSdk.Transaction(transaction, StellarSdk.Networks.TESTNET);
    tx.sign(clientKeypair);
    const signedXdr = tx.toEnvelope().toXDR('base64');

    await sep10.verifyChallenge(signedXdr);
    await assert.rejects(
      () => sep10.verifyChallenge(signedXdr),
      /Challenge is expired, unknown, or already used/,
    );
  });

  test('rejects challenges requested or signed for an unauthorized home_domain', async () => {
    await assert.rejects(
      () => sep10.createChallenge({ account: clientKeypair.publicKey(), home_domain: 'phishing.example.com' }),
      /Unsupported home_domain/,
    );

    // Build a challenge directly signed by serverKeypair for wrong home_domain
    const forgedChallenge = StellarSdk.WebAuth.buildChallengeTx(
      serverKeypair,
      clientKeypair.publicKey(),
      'wrong-domain.org',
      300,
      StellarSdk.Networks.TESTNET,
      'api.sendam.io',
    );
    const tx = new StellarSdk.Transaction(forgedChallenge, StellarSdk.Networks.TESTNET);
    tx.sign(clientKeypair);

    await assert.rejects(
      () => sep10.verifyChallenge(tx.toEnvelope().toXDR('base64')),
      /wrong home domain/i,
    );
  });

  test('binds client_domain and client_signing_key and requires both client and domain signatures', async () => {
    const challenge = await sep10.createChallenge({
      account: clientKeypair.publicKey(),
      home_domain: 'sendam.io',
      client_domain: 'wallet.example.com',
      client_signing_key: walletDomainKeypair.publicKey(),
    });

    assert.equal(challenge.clientDomain, 'wallet.example.com');

    // Only signed by clientKeypair (missing walletDomainKeypair signature) -> must fail
    const txOnlyClient = new StellarSdk.Transaction(challenge.transaction, StellarSdk.Networks.TESTNET);
    txOnlyClient.sign(clientKeypair);
    await assert.rejects(
      () => sep10.verifyChallenge(txOnlyClient.toEnvelope().toXDR('base64')),
      /Invalid signed challenge/,
    );

    // Signed by both clientKeypair and walletDomainKeypair -> succeeds and embeds client_domain claim
    const txBoth = new StellarSdk.Transaction(challenge.transaction, StellarSdk.Networks.TESTNET);
    txBoth.sign(clientKeypair);
    txBoth.sign(walletDomainKeypair);

    const verified = await sep10.verifyChallenge(txBoth.toEnvelope().toXDR('base64'));
    assert.equal(verified.clientDomain, 'wallet.example.com');
    assert.equal(verified.claims.client_domain, 'wallet.example.com');
  });

  test('supports memo ID binding and rejects memo when combined with muxed account (M...)', async () => {
    const challenge = await sep10.createChallenge({
      account: clientKeypair.publicKey(),
      memo: '987654321',
    });
    const tx = new StellarSdk.Transaction(challenge.transaction, StellarSdk.Networks.TESTNET);
    tx.sign(clientKeypair);

    const verified = await sep10.verifyChallenge(tx.toEnvelope().toXDR('base64'));
    assert.equal(verified.sub, `${clientKeypair.publicKey()}:987654321`);
    assert.equal(verified.claims.memo, '987654321');

    const muxed = new StellarSdk.MuxedAccount(
      new StellarSdk.Account(clientKeypair.publicKey(), '0'),
      '12345',
    );
    await assert.rejects(
      () => sep10.createChallenge({ account: muxed.accountId(), memo: '12345' }),
      /Memo cannot be used when account is a muxed account/,
    );
    await assert.rejects(
      () => sep10.createChallenge({ account: clientKeypair.publicKey(), memo: 'not-a-number' }),
      /Invalid memo/,
    );
  });

  test('revoked tokens fail authorization immediately and refresh rotates tokens safely', async () => {
    const { transaction } = await sep10.createChallenge(clientKeypair.publicKey());
    const tx = new StellarSdk.Transaction(transaction, StellarSdk.Networks.TESTNET);
    tx.sign(clientKeypair);
    const { token: initialToken } = await sep10.verifyChallenge(tx.toEnvelope().toXDR('base64'));

    // Refresh token -> rotates to a new token and invalidates the old one
    const refreshed = await sep10.refreshToken(initialToken);
    assert.ok(refreshed.token);
    assert.notEqual(refreshed.token, initialToken);

    // Old token is now revoked
    await assert.rejects(
      () => sep10.verifyToken(initialToken),
      /revoked/i,
    );

    // New token is valid
    const verifiedNew = await sep10.verifyToken(refreshed.token);
    assert.equal(verifiedNew.valid, true);

    // Explicitly revoke the new token
    const revocation = await sep10.revokeToken(refreshed.token);
    assert.equal(revocation.revoked, true);

    // Revoked token fails authorization immediately
    await assert.rejects(
      () => sep10.verifyToken(refreshed.token),
      /revoked/i,
    );
  });

  test('standard GET /auth, POST /auth, POST /auth/refresh, and POST /auth/revoke work over HTTP', async () => {
    const externalWallet = StellarSdk.Keypair.random();

    await withServer(async (base) => {
      // 1. GET /auth issues SEP-10 challenge for external wallet (Freighter / Albedo / CLI)
      const getRes = await fetch(
        `${base}/auth?account=${externalWallet.publicKey()}&home_domain=sendam.io&client_domain=freighter.app`,
      );
      assert.equal(getRes.status, 200);
      const challengeBody = await getRes.json();
      assert.ok(challengeBody.transaction);
      assert.equal(challengeBody.network_passphrase, StellarSdk.Networks.TESTNET);
      assert.equal(challengeBody.home_domain, 'sendam.io');
      assert.equal(challengeBody.client_domain, 'freighter.app');

      // 2. Client signs challenge and submits via POST /auth (form-urlencoded, per SEP-10 spec)
      const tx = new StellarSdk.Transaction(challengeBody.transaction, StellarSdk.Networks.TESTNET);
      tx.sign(externalWallet);
      const signedXdr = tx.toEnvelope().toXDR('base64');

      const postRes = await fetch(`${base}/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ transaction: signedXdr }).toString(),
      });
      assert.equal(postRes.status, 200);
      const tokenBody = await postRes.json();
      assert.ok(tokenBody.token);

      // 3. POST /auth/refresh rotates the token
      const refreshRes = await fetch(`${base}/auth/refresh`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tokenBody.token}` },
      });
      assert.equal(refreshRes.status, 200);
      const refreshedBody = await refreshRes.json();
      assert.ok(refreshedBody.token);
      assert.notEqual(refreshedBody.token, tokenBody.token);

      // 4. POST /auth/revoke revokes the refreshed token
      const revokeRes = await fetch(`${base}/auth/revoke`, {
        method: 'POST',
        headers: { authorization: `Bearer ${refreshedBody.token}` },
      });
      assert.equal(revokeRes.status, 200);
      const revokeBody = await revokeRes.json();
      assert.equal(revokeBody.revoked, true);

      // 5. Refreshing a revoked token fails with 401
      const failedRefresh = await fetch(`${base}/auth/refresh`, {
        method: 'POST',
        headers: { authorization: `Bearer ${refreshedBody.token}` },
      });
      assert.equal(failedRefresh.status, 401);

      // 6. Forged signature from attacker fails with 401
      const getRes2 = await fetch(`${base}/auth?account=${externalWallet.publicKey()}`);
      const challengeBody2 = await getRes2.json();
      const badTx = new StellarSdk.Transaction(challengeBody2.transaction, StellarSdk.Networks.TESTNET);
      badTx.sign(attackerKeypair);
      const badPostRes = await fetch(`${base}/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transaction: badTx.toEnvelope().toXDR('base64') }),
      });
      assert.equal(badPostRes.status, 401);
    });
  });
});
