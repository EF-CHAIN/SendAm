const stellarAdapter = require('./stellar.adapter');
const { encrypt, decrypt } = require('../services/crypto.service');
const { writeAuditLog } = require('../common/audit.service');
const prisma = require('../common/prisma');
const { withIdAlias, withIdAliases } = require('../common/records');
const logger = require('../utils/logger');

// SendAm is Stellar-only. The chain column stays on Wallet for legacy rows
// (a removed Lisk rail once wrote chain='lisk'); those rows are ignored
// everywhere below.
const CHAIN = 'stellar';

// The issued asset every new wallet should be able to receive from day one.
const USDC = 'USDC';

// Open the USDC trustline so a funded wallet can receive USDC immediately.
// Non-fatal, exactly like funding: a failure is logged and the caller carries
// on. establishTrustline is idempotent (no-op when the trustline already
// exists), so this is safe to call on every funding attempt — including the
// fundWallet retry path, which lets a wallet that missed it recover.
const ensureUsdcTrustline = async ({ secretKey, publicKey }) => {
  try {
    await stellarAdapter.establishTrustline({ secretKey, assetCode: USDC });
  } catch (error) {
    logger.warn(
      `USDC trustline failed for ${CHAIN} wallet ${publicKey}: ${error.message}`,
    );
  }
};

// One wallet per user, direct custody: the adapter generates a keypair, the
// secret key is encrypted (crypto.service.js) before it ever touches the
// database. Callers never see a plaintext secret key.
const createOrGetWallet = async ({ user, phoneNumber }) => {
  let owner = user;
  if (!owner) {
    owner = await prisma.user.findUnique({ where: { phoneNumber } });
    if (!owner) owner = await prisma.user.create({ data: { phoneNumber } });
  }

  const existing = await prisma.wallet.findUnique({ where: { userId_chain: { userId: owner.id, chain: CHAIN } } });
  if (existing) return withIdAlias(existing);

  const { publicKey, secretKey } = stellarAdapter.createWallet();

  let wallet = await prisma.wallet.create({
    data: {
      userId: owner.id,
      chain: CHAIN,
      phoneNumber: owner.phoneNumber,
      publicKey,
      encryptedSecretKey: encrypt(secretKey),
    },
  });

  // Attempt funding immediately (Stellar Friendbot on testnet). A failure is
  // non-fatal — callers can retry via fundWallet() later, same as the `fund`
  // WhatsApp command did before.
  try {
    const result = await stellarAdapter.fundTestnetAccount(publicKey);
    if (result.funded) {
      wallet = await prisma.wallet.update({ where: { id: wallet.id }, data: { funded: true } });
      // Funded accounts have the XLM reserve needed to open a trustline.
      await ensureUsdcTrustline({ secretKey, publicKey });
    }
  } catch (error) {
    logger.warn(`Funding failed for new ${CHAIN} wallet ${publicKey}: ${error.message}`);
  }

  await writeAuditLog({
    actorType: 'system',
    actorId: String(owner.id),
    action: 'wallet.created',
    entityType: 'Wallet',
    entityId: String(wallet.id),
    metadata: { chain: CHAIN },
  });

  return withIdAlias(wallet);
};

// Creates (or fetches) the user's Stellar wallet. Kept as a list-returning
// helper because callers render wallet lists.
const ensureWalletsForUser = async ({ user }) => {
  const wallet = await createOrGetWallet({ user });
  return [wallet];
};

const getWalletsByPhoneNumber = async (phoneNumber) => {
  const wallets = await prisma.wallet.findMany({ where: { phoneNumber, chain: CHAIN } });
  return withIdAliases(wallets);
};

const getWalletByUserAndChain = async ({ userId, chain = CHAIN }) => {
  const wallet = await prisma.wallet.findUnique({ where: { userId_chain: { userId, chain } } });
  return withIdAlias(wallet);
};

const fundWallet = async ({ wallet }) => {
  const result = await stellarAdapter.fundTestnetAccount(wallet.publicKey);
  if (result.funded) {
    // Retry the (idempotent) trustline so a wallet that missed it at creation
    // — e.g. funding succeeded but the trustline call failed — recovers here.
    await ensureUsdcTrustline({
      secretKey: decrypt(wallet.encryptedSecretKey),
      publicKey: wallet.publicKey,
    });
    return { wallet: withIdAlias(await prisma.wallet.update({ where: { id: wallet.id }, data: { funded: true } })), result };
  }
  return { wallet: withIdAlias(wallet), result };
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
    : await prisma.wallet.findMany({ where: { phoneNumber, chain: CHAIN } });

  return Promise.all(wallets.map(async (wallet) => {
    try {
      const assets = await stellarAdapter.getBalances(wallet.publicKey);
      return { chain: wallet.chain, address: wallet.publicKey, assets };
    } catch (error) {
      return { chain: wallet.chain, address: wallet.publicKey, assets: [], error: error.message };
    }
  }));
};

const submitPayment = async ({ wallet, destination, amount, asset }) => {
  const secretKey = decrypt(wallet.encryptedSecretKey);
  return stellarAdapter.submitPayment({ secretKey, destination, amount, asset });
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
