const { normalizePaymentStatus } = require('../payment/markFailed');

const mask = (value, { head = 0, tail = 4 } = {}) => {
  if (!value) return null;
  const text = String(value);
  if (text.length <= head + tail) return '*'.repeat(text.length);
  return `${text.slice(0, head)}${'*'.repeat(Math.min(8, text.length - head - tail))}${text.slice(-tail)}`;
};

// Explicit DTOs are deliberately constructed field-by-field. Adding a Prisma
// model field can therefore never make it appear in an admin response.
const userDto = (user) => ({
  id: user.id,
  displayName: user.whatsappName ? `${user.whatsappName.slice(0, 1)}***` : null,
  phoneNumber: mask(user.phoneNumber),
  kycTier: user.kycTier,
  createdAt: user.createdAt,
  wallets: (user.wallets || []).map((wallet) => ({
    chain: wallet.chain,
    network: wallet.network,
    funded: wallet.funded,
    publicKey: mask(wallet.publicKey, { head: 5, tail: 4 }),
  })),
});

const walletDto = (wallet) => ({
  id: wallet.id,
  chain: wallet.chain,
  network: wallet.network,
  funded: wallet.funded,
  publicKey: mask(wallet.publicKey, { head: 5, tail: 4 }),
  owner: wallet.user ? {
    id: wallet.user.id,
    phoneNumber: mask(wallet.user.phoneNumber),
  } : null,
  createdAt: wallet.createdAt,
});

const transactionDto = (transaction) => ({
  id: transaction.id,
  type: transaction.type,
  amount: transaction.amount,
  asset: transaction.asset,
  rail: transaction.rail,
  routeType: transaction.routeType,
  status: normalizePaymentStatus(transaction.status),
  destination: mask(transaction.destination, { head: 5, tail: 4 }),
  recipient: mask(transaction.recipientPhoneNumber),
  transactionHash: mask(transaction.txHash, { head: 6, tail: 6 }),
  user: transaction.user ? {
    id: transaction.user.id,
    phoneNumber: mask(transaction.user.phoneNumber),
  } : null,
  createdAt: transaction.createdAt,
  updatedAt: transaction.updatedAt,
});

const kycProfileDto = (profile) => ({
  id: profile.id,
  user: profile.user ? {
    id: profile.user.id,
    phoneNumber: mask(profile.user.phoneNumber),
  } : null,
  tier: profile.tier,
  status: profile.status,
  country: profile.country,
  riskScore: profile.riskScore,
  sanctionsStatus: profile.sanctionsStatus,
  sanctionsScreenedAt: profile.sanctionsScreenedAt,
  custodyStatus: profile.custodyStatus,
  custodyReviewedAt: profile.custodyReviewedAt,
  lastScreenedAt: profile.lastScreenedAt,
  createdAt: profile.createdAt,
  updatedAt: profile.updatedAt,
});

module.exports = { mask, userDto, walletDto, transactionDto, kycProfileDto };
