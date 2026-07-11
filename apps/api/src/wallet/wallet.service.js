const { resolveAdapter, SUPPORTED_CHAINS } = require('./chainRegistry');
const { encrypt, decrypt } = require('../services/crypto.service');
const { writeAuditLog } = require('../common/audit.service');
const prisma = require('../common/prisma');
const { withIdAlias, withIdAliases } = require('../common/records');
const logger = require('../utils/logger');

// One wallet per user per chain, direct custody: the adapter generates a
// keypair, the secret key is encrypted (crypto.service.js) before it ever
// touches the database. Callers never see a plaintext secret key.
const createOrGetWallet = async ({ user, phoneNumber, chain = 'lisk' }) => {
  let owner = user;
  if (!owner) {
    owner = await prisma.user.findUnique({ where: { phoneNumber } });
    if (!owner) owner = await prisma.user.create({ data: { phoneNumber } });
  }

  const existing = await prisma.wallet.findUnique({ where: { userId_chain: { userId: owner.id, chain } } });
  if (existing) return withIdAlias(existing);

  const adapter = resolveAdapter(chain);
  const { publicKey, secretKey } = adapter.createWallet();

  let wallet = await prisma.wallet.create({
    data: {
      userId: owner.id,
      chain,
      phoneNumber: owner.phoneNumber,
      publicKey,
      encryptedSecretKey: encrypt(secretKey),
    },
  });

  // Attempt funding immediately for chains with an auto-fund faucet
  // (Stellar's Friendbot). Lisk has none — the wallet is created unfunded
  // and callers can retry via fundWallet() later, same as the `fund`
  // WhatsApp command did before.
  try {
    const result = await adapter.fundTestnetAccount(publicKey);
    if (result.funded) {
      wallet = await prisma.wallet.update({ where: { id: wallet.id }, data: { funded: true } });
    }
  } catch (error) {
    logger.warn(`Funding failed for new ${chain} wallet ${publicKey}: ${error.message}`);
  }

  await writeAuditLog({
    actorType: 'system',
    actorId: String(owner.id),
    action: 'wallet.created',
    entityType: 'Wallet',
    entityId: String(wallet.id),
    metadata: { chain },
  });

  return withIdAlias(wallet);
};

// Creates (or fetches) a wallet on every supported chain for a user — the
// product surface never asks a user to "pick a chain".
const ensureWalletsForUser = async ({ user }) => {
  const wallets = await Promise.all(SUPPORTED_CHAINS.map((chain) => createOrGetWallet({ user, chain })));
  return wallets;
};

const getWalletsByPhoneNumber = async (phoneNumber) => {
  const wallets = await prisma.wallet.findMany({ where: { phoneNumber } });
  return withIdAliases(wallets);
};

const getWalletByUserAndChain = async ({ userId, chain }) => {
  const wallet = await prisma.wallet.findUnique({ where: { userId_chain: { userId, chain } } });
  return withIdAlias(wallet);
};

const fundWallet = async ({ wallet }) => {
  const adapter = resolveAdapter(wallet.chain);
  const result = await adapter.fundTestnetAccount(wallet.publicKey);
  if (result.funded) {
    return { wallet: withIdAlias(await prisma.wallet.update({ where: { id: wallet.id }, data: { funded: true } })), result };
  }
  return { wallet: withIdAlias(wallet), result };
};

const balance = async ({ wallet }) => {
  const value = await resolveAdapter(wallet.chain).getBalance(wallet.publicKey);
  return { chain: wallet.chain, address: wallet.publicKey, value };
};

// Balances across every chain a user (or phone number) has a wallet on. Each
// chain's fetch is isolated so one unreachable RPC/Horizon doesn't blank out
// the others.
const balancesForUser = async ({ userId, phoneNumber }) => {
  const wallets = userId
    ? await prisma.wallet.findMany({ where: { userId } })
    : await prisma.wallet.findMany({ where: { phoneNumber } });

  return Promise.all(wallets.map(async (wallet) => {
    try {
      return await balance({ wallet });
    } catch (error) {
      return { chain: wallet.chain, address: wallet.publicKey, value: null, error: error.message };
    }
  }));
};

const submitPayment = async ({ wallet, destination, amount, asset }) => {
  const secretKey = decrypt(wallet.encryptedSecretKey);
  return resolveAdapter(wallet.chain).submitPayment({ secretKey, destination, amount, asset });
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
  balance,
  balancesForUser,
  submitPayment,
  transactionHistory,
};
