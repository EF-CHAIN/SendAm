const config = require('../config/env');
const thirdweb = require('./thirdweb.adapter');
const openfort = require('./openfort.adapter');
const { writeAuditLog } = require('../common/audit.service');
const prisma = require('../common/prisma');
const { withIdAlias, withIdAliases } = require('../common/records');

const providerName = () => config.walletProvider || 'thirdweb';
const provider = () => (providerName() === 'openfort' ? openfort : thirdweb);

const walletLabelForPhone = (phoneNumber) => `sendam-${String(phoneNumber).replace(/\D/g, '')}`;

const createOrGetWallet = async ({ user, phoneNumber }) => {
  let owner = user;
  if (!owner) {
    owner = await prisma.user.findUnique({ where: { phoneNumber } });
    if (!owner) owner = await prisma.user.create({ data: { phoneNumber } });
  }

  const existing = await prisma.wallet.findUnique({ where: { userId: owner.id } });
  if (existing) return withIdAlias(existing);

  const managedWallet = await provider().createManagedWallet({
    phoneNumber: owner.phoneNumber,
    label: walletLabelForPhone(owner.phoneNumber),
  });

  const wallet = await prisma.wallet.create({
    data: {
      userId: owner.id,
      phoneNumber: owner.phoneNumber,
      provider: providerName(),
      providerWalletId: managedWallet.providerWalletId,
      address: managedWallet.address,
      publicKey: managedWallet.address,
      primaryChain: 'lisk',
      supportedChains: ['lisk', 'stellar'],
      network: 'managed',
    },
  });

  await prisma.user.update({
    where: { id: owner.id },
    data: { walletId: wallet.id },
  });
  await writeAuditLog({
    actorType: 'system',
    actorId: String(owner.id),
    action: 'wallet.created',
    entityType: 'Wallet',
    entityId: String(wallet.id),
    metadata: { provider: wallet.provider },
  });

  return withIdAlias(wallet);
};

const getWalletByPhoneNumber = async (phoneNumber) => {
  const wallet = await prisma.wallet.findFirst({ where: { phoneNumber } });
  return withIdAlias(wallet);
};

const balance = async ({ wallet, chain = config.thirdweb.defaultChain }) => {
  return provider().getBalance({ chain, address: wallet.address || wallet.publicKey });
};

const sendToken = async ({ wallet, chain, destination, amount, tokenAddress }) => {
  return provider().sendToken({
    chain,
    fromAddress: wallet.address || wallet.publicKey,
    destination,
    amount,
    tokenAddress,
  });
};

const transactionHistory = async ({ userId, Transaction }) => {
  const history = await prisma.transaction.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return withIdAliases(history);
};

module.exports = {
  createOrGetWallet,
  getWalletByPhoneNumber,
  balance,
  sendToken,
  transactionHistory,
};
