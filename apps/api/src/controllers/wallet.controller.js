const { isValidAmount } = require('../utils/validators');
const { sendSuccess, sendError } = require('../utils/response');
const walletService = require('../wallet/wallet.service');
const { validateAddress } = require('../wallet/stellar.adapter');
const { executePayment } = require('../payment/payment.orchestrator');

const createWallet = async (req, res, next) => {
  try {
    const user = req.restUser;

    const wallets = await walletService.ensureWalletsForUser({ user });

    return sendSuccess(res, {
      wallets: wallets.map((w) => ({ chain: w.chain, publicKey: w.publicKey, funded: w.funded, network: w.network })),
    }, 'Wallets ready', 201);
  } catch (error) {
    next(error);
  }
};

const checkBalance = async (req, res, next) => {
  try {
    const balances = await walletService.balancesForUser({ phoneNumber: req.restUser.phoneNumber });
    if (balances.length === 0) return sendError(res, 'Wallet not found', 404);

    return sendSuccess(res, { balances }, 'Balances fetched successfully');
  } catch (error) {
    next(error);
  }
};

const sendFunds = async (req, res, next) => {
  try {
    const { amount, destination } = req.body;

    if (!isValidAmount(amount) || !destination) {
      return sendError(res, 'A valid amount and destination are required');
    }
    if (!validateAddress(String(destination).trim())) {
      return sendError(res, 'Destination must be a valid Stellar address');
    }

    const user = req.restUser;

    const result = await executePayment({
      sender: user,
      destination,
      amount,
      asset: req.body.asset,
      routeType: req.body.routeType,
      sourceCountry: req.body.sourceCountry,
      destinationCountry: req.body.destinationCountry,
    });

    return sendSuccess(res, {
      transactionId: result.transaction._id,
      status: result.transaction.status,
      rail: result.transaction.rail,
      receipt: result.receipt,
    }, 'Payment accepted');
  } catch (error) {
    next(error);
  }
};

const getTransactionHistory = async (req, res, next) => {
  try {
    const history = await walletService.transactionHistory({ userId: req.restUser.id });
    return sendSuccess(res, history);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createWallet,
  checkBalance,
  sendFunds,
  getTransactionHistory,
};
