const stellarAdapter = require('./stellar.adapter');
const { encrypt, decrypt } = require('../services/crypto.service');
const { writeAuditLog } = require('../common/audit.service');
const { appendEvent, EVENT_TYPES } = require('../common/event.service');
const { assertAccountActive } = require('../compliance/account.service');
const prisma = require('../common/prisma');
const { withIdAlias, withIdAliases } = require('../common/records');
const logger = require('../utils/logger');
const { canonicalizePhoneNumber } = require('../utils/validators');

// SendAm is Stellar-only. The chain column stays on Wallet for legacy rows
// (a removed Lisk rail once wrote chain='lisk'); those rows are ignored
// everywhere below.
const CHAIN = 'stellar';

// The issued asset every new wallet should be able to receive from day one.
const USDC = 'USDC';
const PROVISIONING_LEASE_MS = 5 * 60 * 1000;
const errorMessage = (error) => String(error?.message || error || 'Unknown provider failure').slice(0, 500);

// Open the USDC trustline so a funded wallet can receive USDC immediately.
// Non-fatal, exactly like funding: a failure is logged and the caller carries
// on. establishTrustline is idempotent (no-op when the trustline already
// exists), so this is safe to call on every funding attempt — including the
// fundWallet retry path, which lets a wallet that missed it recover.
const ensureUsdcTrustline = async ({ wallet }) => {
  if (wallet.fundingState !== 'succeeded' && !wallet.funded) return wallet;
  const now = new Date();
  const claimed = await prisma.wallet.updateMany({
    where: { id: wallet.id, OR: [
      { trustlineState: { in: ['pending', 'blocked', 'failed'] } },
      { trustlineState: 'in_progress', trustlineUpdatedAt: { lt: new Date(now.getTime() - PROVISIONING_LEASE_MS) } },
    ] },
    data: { trustlineState: 'in_progress', trustlineAttempts: { increment: 1 }, trustlineError: null, trustlineUpdatedAt: now },
  });
  if (claimed.count === 0) return prisma.wallet.findUnique({ where: { id: wallet.id } });
  try {
    await stellarAdapter.establishTrustline({ secretKey: decrypt(wallet.encryptedSecretKey), assetCode: USDC });
    return prisma.wallet.update({ where: { id: wallet.id }, data: { trustlineState: 'succeeded', trustlineError: null, trustlineUpdatedAt: new Date() } });
  } catch (error) {
    logger.warn(`USDC trustline failed for ${CHAIN} wallet ${wallet.publicKey}: ${error.message}`);
    await prisma.wallet.update({ where: { id: wallet.id }, data: { trustlineState: 'failed', trustlineError: errorMessage(error), trustlineUpdatedAt: new Date() } });
    await writeAuditLog({ actorType: 'system', action: 'wallet.trustline.failed', entityType: 'Wallet', entityId: String(wallet.id), metadata: { retryable: true, error: errorMessage(error) } });
    return prisma.wallet.findUnique({ where: { id: wallet.id } });
  }
};

const provisionWallet = async (walletId) => {
  let wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) throw Object.assign(new Error('Wallet not found'), { statusCode: 404 });
  if (wallet.fundingState !== 'succeeded' && !wallet.funded) {
    const now = new Date();
    const claimed = await prisma.wallet.updateMany({
      where: { id: wallet.id, OR: [
        { fundingState: { in: ['pending', 'failed'] } },
        { fundingState: 'in_progress', fundingUpdatedAt: { lt: new Date(now.getTime() - PROVISIONING_LEASE_MS) } },
      ] },
      data: { fundingState: 'in_progress', fundingAttempts: { increment: 1 }, fundingError: null, fundingUpdatedAt: now },
    });
    if (claimed.count === 0) return prisma.wallet.findUnique({ where: { id: wallet.id } });
    try {
      const result = await stellarAdapter.fundTestnetAccount(wallet.publicKey);
      if (!result.funded) throw new Error('Funding provider did not confirm funding');
      wallet = await prisma.wallet.update({ where: { id: wallet.id }, data: { funded: true, fundingState: 'succeeded', fundingError: null, fundingUpdatedAt: new Date(), trustlineState: 'pending' } });
    } catch (error) {
      logger.warn(`Funding failed for ${CHAIN} wallet ${wallet.publicKey}: ${error.message}`);
      await prisma.wallet.update({ where: { id: wallet.id }, data: { fundingState: 'failed', fundingError: errorMessage(error), fundingUpdatedAt: new Date() } });
      await writeAuditLog({ actorType: 'system', action: 'wallet.funding.failed', entityType: 'Wallet', entityId: String(wallet.id), metadata: { retryable: true, error: errorMessage(error) } });
      return prisma.wallet.findUnique({ where: { id: wallet.id } });
    }
  }
  return ensureUsdcTrustline({ wallet });
};

// One wallet per user, direct custody: the adapter generates a keypair, the
// secret key is encrypted (crypto.service.js) before it ever touches the
// database. Callers never see a plaintext secret key.
const createOrGetWallet = async ({ user, phoneNumber }) => {
  let owner = user;
  if (!owner) {
    const canonicalPhone = canonicalizePhoneNumber(phoneNumber);
    owner = await prisma.user.upsert({
      where: { phoneNumber: canonicalPhone },
      create: { phoneNumber: canonicalPhone },
      update: {},
    });
  }
  assertAccountActive(owner);

  const existing = await prisma.wallet.findUnique({ where: { userId_chain: { userId: owner.id, chain: CHAIN } } });
  if (existing) return withIdAlias(await provisionWallet(existing.id));

  const { publicKey, secretKey } = stellarAdapter.createWallet();

  let wallet;
  try {
    wallet = await prisma.wallet.create({
      data: { userId: owner.id, chain: CHAIN, phoneNumber: owner.phoneNumber, publicKey, encryptedSecretKey: encrypt(secretKey) },
    });
  } catch (error) {
    if (error.code !== 'P2002') throw error;
    const winner = await prisma.wallet.findUnique({ where: { userId_chain: { userId: owner.id, chain: CHAIN } } });
    if (!winner) throw error;
    logger.info(`Recovered concurrent ${CHAIN} wallet creation for user ${owner.id}`);
    await writeAuditLog({ actorType: 'system', actorId: String(owner.id), action: 'wallet.creation.race_recovered', entityType: 'Wallet', entityId: String(winner.id), metadata: { chain: CHAIN } });
    return withIdAlias(winner);
  }

  // Attempt funding immediately (Stellar Friendbot on testnet). A failure is
  // non-fatal — callers can retry via fundWallet() later, same as the `fund`
  // WhatsApp command did before.
  wallet = await provisionWallet(wallet.id);

  await writeAuditLog({
    actorType: 'system',
    actorId: String(owner.id),
    action: 'wallet.created',
    entityType: 'Wallet',
    entityId: String(wallet.id),
    metadata: { chain: CHAIN },
  });

  // Durable workflow event (#318)
  await appendEvent({
    eventType: EVENT_TYPES.WALLET_CREATED,
    aggregateType: 'Wallet',
    aggregateId: String(wallet.id),
    actorType: 'system',
    actorId: String(owner.id),
    payload: { chain: CHAIN, publicKey: wallet.publicKey, network: wallet.network },
  }).catch(() => {});

  return withIdAlias(wallet);
};

// Creates (or fetches) the user's Stellar wallet. Kept as a list-returning
// helper because callers render wallet lists.
const ensureWalletsForUser = async ({ user }) => {
  const wallet = await createOrGetWallet({ user });
  return [wallet];
};

const getWalletsByPhoneNumber = async (phoneNumber) => {
  const canonicalPhone = canonicalizePhoneNumber(phoneNumber);
  const wallets = await prisma.wallet.findMany({ where: { phoneNumber: canonicalPhone, chain: CHAIN } });
  return withIdAliases(wallets);
};

const getWalletByUserAndChain = async ({ userId, chain = CHAIN }) => {
  const wallet = await prisma.wallet.findUnique({ where: { userId_chain: { userId, chain } } });
  return withIdAlias(wallet);
};

const fundWallet = async ({ wallet }) => {
  const provisioned = await provisionWallet(wallet.id);
  return {
    wallet: withIdAlias(provisioned),
    result: { funded: provisioned.funded, fundingState: provisioned.fundingState, trustlineState: provisioned.trustlineState },
  };
};

const balance = async ({ wallet }) => {
  const value = await stellarAdapter.getBalance(wallet.publicKey);
  return { chain: wallet.chain, address: wallet.publicKey, value };
};

// Balances for every Stellar wallet a user (or phone number) has. Each wallet
// returns per-asset rows via getBalances() so XLM and USDC (and future assets)
// are surfaced individually. Each fetch is isolated — a Horizon failure for
// one wallet sets error and leaves assets empty rather than blanking the whole
// reply. Legacy non-Stellar rows are excluded by query.
const balancesForUser = async ({ userId, phoneNumber }) => {
  const wallets = userId
    ? await prisma.wallet.findMany({ where: { userId, chain: CHAIN } })
    : await prisma.wallet.findMany({ where: { phoneNumber: canonicalizePhoneNumber(phoneNumber), chain: CHAIN } });

  return Promise.all(wallets.map(async (wallet) => {
    try {
      const assets = await stellarAdapter.getBalances(wallet.publicKey);
      return { chain: wallet.chain, address: wallet.publicKey, assets };
    } catch (error) {
      return { chain: wallet.chain, address: wallet.publicKey, assets: [], error: error.message };
    }
  }));
};

const submitPayment = async ({ wallet, destination, amount, asset, memo, memoType }) => {
  const secretKey = decrypt(wallet.encryptedSecretKey);
  return stellarAdapter.submitPayment({ secretKey, destination, amount, asset, memo, memoType });
};

const transactionHistory = async ({ userId }) => {
  const history = await prisma.transaction.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return withIdAliases(history);
};

module.exports = {
  createOrGetWallet,
  ensureWalletsForUser,
  getWalletsByPhoneNumber,
  getWalletByUserAndChain,
  fundWallet,
  provisionWallet,
  balance,
  balancesForUser,
  submitPayment,
  transactionHistory,
};
