const crypto = require('crypto');
const { StellarSdk } = require('../config/stellar');
const config = require('../config/env');
const prisma = require('../common/prisma');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const networkPassphrase = () => (
  config.stellar.network === 'testnet' ? StellarSdk.Networks.TESTNET : StellarSdk.Networks.PUBLIC
);
const challengeDigest = (transaction) => new StellarSdk.Transaction(
  transaction, networkPassphrase(),
).hash().toString('hex');

const authConfig = () => {
  const settings = config.stellar.auth;
  if (!settings.signingKey || !settings.homeDomain || !settings.webAuthDomain) {
    throw new Error('Stellar authentication is not configured');
  }
  return settings;
};

const createChallenge = async (account) => {
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(account)) {
    throw new Error('A valid Stellar account is required');
  }
  const settings = authConfig();
  const serverKeypair = StellarSdk.Keypair.fromSecret(settings.signingKey);
  const transaction = StellarSdk.WebAuth.buildChallengeTx(
    serverKeypair,
    account,
    settings.homeDomain,
    settings.challengeTtlSeconds,
    networkPassphrase(),
    settings.webAuthDomain,
  );
  await prisma.sep10Challenge.create({
    data: {
      account,
      challengeHash: challengeDigest(transaction),
      expiresAt: new Date(Date.now() + settings.challengeTtlSeconds * 1000),
    },
  });
  return { transaction, networkPassphrase: networkPassphrase() };
};

const verifyChallenge = async (signedTransaction) => {
  if (typeof signedTransaction !== 'string' || signedTransaction.length > 10000) {
    throw new Error('Malformed challenge transaction');
  }
  const settings = authConfig();
  const serverKeypair = StellarSdk.Keypair.fromSecret(settings.signingKey);
  let challenge;
  try {
    challenge = StellarSdk.WebAuth.readChallengeTx(
      signedTransaction,
      serverKeypair.publicKey(),
      networkPassphrase(),
      [settings.homeDomain],
      settings.webAuthDomain,
    );
    StellarSdk.WebAuth.verifyChallengeTxSigners(
      signedTransaction,
      serverKeypair.publicKey(),
      networkPassphrase(),
      [challenge.clientAccountID],
      [settings.homeDomain],
      settings.webAuthDomain,
    );
  } catch (_error) {
    throw new Error('Invalid signed challenge');
  }

  const challengeHash = challengeDigest(signedTransaction);
  const wallet = await prisma.wallet.findFirst({
    where: { publicKey: challenge.clientAccountID, network: config.stellar.network },
    include: { user: true },
  });
  if (!wallet) throw new Error('Stellar account is not linked to a user on this network');

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + settings.sessionTtlMinutes * 60 * 1000);
  await prisma.$transaction(async (tx) => {
    const consumed = await tx.sep10Challenge.updateMany({
      where: {
        challengeHash,
        account: challenge.clientAccountID,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw new Error('Challenge is expired, unknown, or already used');
    await tx.restSession.create({
      data: { userId: wallet.userId, account: challenge.clientAccountID, tokenHash: hash(token), expiresAt },
    });
  });
  return { token, expiresAt, user: wallet.user, account: challenge.clientAccountID };
};

const findSession = async (token) => {
  if (typeof token !== 'string' || token.length < 32) return null;
  const session = await prisma.restSession.findUnique({
    where: { tokenHash: hash(token) },
    include: { user: true },
  });
  if (!session || session.revokedAt || session.expiresAt <= new Date()) return null;
  await prisma.restSession.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } });
  return session;
};

const revokeSession = (sessionId) => prisma.restSession.update({
  where: { id: sessionId }, data: { revokedAt: new Date() },
});

module.exports = { createChallenge, verifyChallenge, findSession, revokeSession, hash };
