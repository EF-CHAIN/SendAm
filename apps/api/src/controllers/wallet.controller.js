const { isValidPhoneNumber, isValidAmount } = require('../utils/validators');
const { sendSuccess, sendError } = require('../utils/response');
const walletService = require('../wallet/wallet.service');
const { detectChainFromAddress } = require('../wallet/chainRegistry');
const { executePayment } = require('../payment/payment.orchestrator');
const prisma = require('../common/prisma');

const createWallet = async (req, res, next) => {
  try {
    const { phoneNumber } = req.body;
    if (!isValidPhoneNumber(phoneNumber)) return sendError(res, 'A valid phone number is required');

    let user = await prisma.user.findUnique({ where: { phoneNumber } });
    if (!user) {
      user = await prisma.user.create({ data: { phoneNumber } });
    }

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
    const { phone } = req.params;
    if (!isValidPhoneNumber(phone)) return sendError(res, 'A valid phone number is required');

    const balances = await walletService.balancesForUser({ phoneNumber: phone });
    if (balances.length === 0) return sendError(res, 'Wallet not found for this phone number', 404);

    return sendSuccess(res, { balances }, 'Balances fetched successfully');
  } catch (error) {
    next(error);
  }
};

const sendFunds = async (req, res, next) => {
  try {
    const { phoneNumber, amount, destination } = req.body;

    if (!isValidPhoneNumber(phoneNumber) || !isValidAmount(amount) || !destination) {
      return sendError(res, 'A valid phone number, amount, and destination are required');
    }
    if (!detectChainFromAddress(destination)) {
      return sendError(res, 'Destination must be a valid Stellar or Lisk address');
    }

    const user = await prisma.user.findUnique({ where: { phoneNumber } });
    if (!user) return sendError(res, 'User not found', 404);

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
    const { phone } = req.params;
    if (!isValidPhoneNumber(phone)) return sendError(res, 'A valid phone number is required');

    const user = await prisma.user.findUnique({ where: { phoneNumber: phone } });
    if (!user) return sendError(res, 'User not found', 404);

    const history = await walletService.transactionHistory({ userId: user.id });
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
