const {
  createWalletForUser,
  getWalletsByUserId,
  getWalletsByPhoneNumber,
  markWalletFunded,
  SUPPORTED_CHAINS,
} = require('../services/wallet.service');
const { resolveAdapter, detectChainFromAddress } = require('../services/chains');
const { executeSend } = require('../services/transaction.service');
const { isValidPhoneNumber, isValidAmount } = require('../utils/validators');
const User = require('../models/User');
const { sendSuccess, sendError } = require('../utils/response');

// Testnet-only convenience: attempt funding for a freshly created wallet.
// Stellar auto-funds via Friendbot; Lisk has no equivalent, so it's returned
// unfunded with manual instructions rather than pretending to have funded it.
const attemptFund = async (chain, wallet) => {
  if (chain === 'stellar') {
    await resolveAdapter(chain).fundTestnetAccount(wallet.publicKey);
    return markWalletFunded(wallet._id);
  }
  return wallet;
};

const createWallet = async (req, res, next) => {
  try {
    const { phoneNumber } = req.body;
    if (!isValidPhoneNumber(phoneNumber)) return sendError(res, 'A valid phone number is required');

    let user = await User.findOne({ phoneNumber });
    if (!user) {
      user = await User.create({ phoneNumber });
    }

    const existingWallets = await getWalletsByUserId(user._id);
    const walletsByChain = Object.fromEntries(existingWallets.map((w) => [w.chain, w]));

    const wallets = [];
    for (const chain of SUPPORTED_CHAINS) {
      let wallet = walletsByChain[chain];
      const alreadyExisted = Boolean(wallet);
      if (!wallet) {
        wallet = await createWalletForUser(user._id, chain);
      }
      if (!wallet.funded) {
        wallet = await attemptFund(chain, wallet);
      }
      wallets.push({ chain, publicKey: wallet.publicKey, network: wallet.network, funded: wallet.funded, alreadyExisted });
    }

    const anyNew = wallets.some((w) => !w.alreadyExisted);
    return sendSuccess(
      res,
      { wallets: wallets.map(({ alreadyExisted, ...rest }) => rest) },
      anyNew ? 'Wallet setup complete' : 'Wallets already exist',
      anyNew ? 201 : 200
    );
  } catch (error) {
    next(error);
  }
};

const checkBalance = async (req, res, next) => {
  try {
    const { phone } = req.params;
    if (!isValidPhoneNumber(phone)) return sendError(res, 'A valid phone number is required');

    const wallets = await getWalletsByPhoneNumber(phone);
    if (wallets.length === 0) return sendError(res, 'Wallet not found for this phone number', 404);

    const balances = await Promise.all(
      wallets.map(async (wallet) => {
        try {
          const balance = await resolveAdapter(wallet.chain).getBalance(wallet.publicKey);
          return { chain: wallet.chain, publicKey: wallet.publicKey, balance };
        } catch (error) {
          return { chain: wallet.chain, publicKey: wallet.publicKey, balance: null, error: error.message };
        }
      })
    );

    return sendSuccess(res, { balances }, 'Balances fetched successfully');
  } catch (error) {
    next(error);
  }
};

const sendFunds = async (req, res, next) => {
  try {
    const { phoneNumber, amount, destination, asset } = req.body;

    if (!isValidPhoneNumber(phoneNumber) || !isValidAmount(amount) || !destination) {
      return sendError(res, 'A valid phone number, amount, and destination are required');
    }

    const chain = detectChainFromAddress(destination);
    if (!chain) {
      return sendError(res, 'Destination must be a valid Stellar or Lisk address');
    }

    const user = await User.findOne({ phoneNumber });
    if (!user) return sendError(res, 'User not found', 404);

    const wallets = await getWalletsByUserId(user._id);
    const wallet = wallets.find((w) => w.chain === chain);
    if (!wallet) return sendError(res, `No ${chain} wallet found for this user`, 404);

    const result = await executeSend({ user, wallet, destination, amount, asset });
    if (!result.ok) {
      return sendError(res, result.error.message || 'Transaction failed');
    }

    return sendSuccess(res, {
      chain,
      txHash: result.txHash,
      explorerUrl: result.explorerUrl
    }, 'Transaction successful');
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createWallet,
  checkBalance,
  sendFunds
};
