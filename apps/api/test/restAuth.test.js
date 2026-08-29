const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const StellarSdk = require('@stellar/stellar-sdk');

const server = StellarSdk.Keypair.random();
const client = StellarSdk.Keypair.random();
const other = StellarSdk.Keypair.random();
const rows = new Map();
const sessions = [];
let currentSession;
let sessionCreateError;
const user = { id: 'user-1', phoneNumber: '+2348000000001' };

const prisma = {
  sep10Challenge: {
    create: async ({ data }) => { rows.set(data.challengeHash, { ...data, consumedAt: null }); },
    updateMany: async ({ where, data }) => {
      const row = rows.get(where.challengeHash);
      if (!row || row.account !== where.account || row.consumedAt || row.expiresAt <= new Date()) return { count: 0 };
      Object.assign(row, data); return { count: 1 };
    },
  },
  wallet: { findFirst: async ({ where }) => (
    where.publicKey === client.publicKey() && where.network === 'testnet'
      ? { userId: user.id, user } : null
  ) },
  restSession: {
    create: async ({ data }) => {
      if (sessionCreateError) throw sessionCreateError;
      sessions.push(data);
    },
    findUnique: async ({ where }) => currentSession?.tokenHash === where.tokenHash ? currentSession : null,
    update: async () => null,
  },
  $transaction: async (fn) => {
    const consumed = new Map([...rows].map(([key, row]) => [key, row.consumedAt]));
    try {
      return await fn(prisma);
    } catch (error) {
      for (const [key, value] of consumed) rows.get(key).consumedAt = value;
      throw error;
    }
  },
};

const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
inject('common/prisma', prisma);
inject('config/stellar', { StellarSdk });
inject('config/env', {
  stellar: {
    network: 'testnet',
    auth: {
      signingKey: server.secret(), homeDomain: 'sendam.test',
      webAuthDomain: 'api.sendam.test', challengeTtlSeconds: 300, sessionTtlMinutes: 15,
    },
  },
});

const auth = require('../src/services/restAuth.service');

beforeEach(() => {
  rows.clear(); sessions.length = 0; currentSession = null; sessionCreateError = null;
});

const signedChallenge = async () => {
  const { transaction } = await auth.createChallenge(client.publicKey());
  const tx = new StellarSdk.Transaction(transaction, StellarSdk.Networks.TESTNET);
  tx.sign(client);
  return tx.toEnvelope().toXDR('base64');
};

test('valid SEP-10 challenge creates a short-lived session bound to its user', async () => {
  const result = await auth.verifyChallenge(await signedChallenge());
  assert.equal(result.user.id, user.id);
  assert.equal(result.account, client.publicKey());
  assert.ok(result.token.length >= 32);
  assert.equal(sessions[0].userId, user.id);
  assert.equal(sessions[0].account, client.publicKey());
  assert.notEqual(sessions[0].tokenHash, result.token);
});

test('a signed challenge is single use', async () => {
  const signed = await signedChallenge();
  await auth.verifyChallenge(signed);
  await assert.rejects(auth.verifyChallenge(signed), /already used/);
});

test('session creation failure rolls challenge consumption back for a safe retry', async () => {
  const signed = await signedChallenge();
  sessionCreateError = new Error('database unavailable');
  await assert.rejects(auth.verifyChallenge(signed), /database unavailable/);
  assert.equal([...rows.values()][0].consumedAt, null);
  sessionCreateError = null;
  assert.equal((await auth.verifyChallenge(signed)).user.id, user.id);
});

test('expired stored challenges fail', async () => {
  const signed = await signedChallenge();
  for (const row of rows.values()) row.expiresAt = new Date(Date.now() - 1);
  await assert.rejects(auth.verifyChallenge(signed), /expired/);
});

test('malformed and wrong-account signatures fail safely', async () => {
  await assert.rejects(auth.verifyChallenge('not-xdr'), /Invalid signed challenge|Malformed/);
  const { transaction } = await auth.createChallenge(client.publicKey());
  const tx = new StellarSdk.Transaction(transaction, StellarSdk.Networks.TESTNET);
  tx.sign(other);
  await assert.rejects(auth.verifyChallenge(tx.toEnvelope().toXDR('base64')), /Invalid signed challenge/);
});

test('wrong domain and wrong network challenges fail', async () => {
  for (const [domain, network] of [
    ['evil.test', StellarSdk.Networks.TESTNET],
    ['sendam.test', StellarSdk.Networks.PUBLIC],
  ]) {
    const xdr = StellarSdk.WebAuth.buildChallengeTx(
      server, client.publicKey(), domain, 300, network, 'api.sendam.test',
    );
    const tx = new StellarSdk.Transaction(xdr, network);
    tx.sign(client);
    await assert.rejects(auth.verifyChallenge(tx.toEnvelope().toXDR('base64')), /Invalid signed challenge/);
  }
});

test('sessions are scoped, expiring, and revocable', async () => {
  const token = 'a'.repeat(43);
  currentSession = { id: 's1', userId: user.id, user, tokenHash: auth.hash(token), expiresAt: new Date(Date.now() + 1000), revokedAt: null };
  assert.equal((await auth.findSession(token)).user.id, user.id);
  currentSession.expiresAt = new Date(Date.now() - 1);
  assert.equal(await auth.findSession(token), null);
  currentSession.expiresAt = new Date(Date.now() + 1000);
  currentSession.revokedAt = new Date();
  assert.equal(await auth.findSession(token), null);
});
