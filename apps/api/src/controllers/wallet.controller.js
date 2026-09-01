const { isValidAmount } = require('../utils/validators');
const { sendSuccess, sendError } = require('../utils/response');
const walletService = require('../wallet/wallet.service');
const { validateAddress } = require('../wallet/stellar.adapter');
const { executePayment } = require('../payment/payment.orchestrator');
const {
  IdempotencyError,
  validateKey,
  fingerprintRequest,
  idempotencyService,
} = require('../payment/idempotency.service');

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
    const { amount, destination } = req.body || {};
    const idempotencyKey = (req.get ? req.get('Idempotency-Key') : req.headers?.['idempotency-key']) || req.body?.idempotencyKey;

    if (idempotencyKey && !validateKey(idempotencyKey)) {
      return sendError(res, 'Idempotency-Key header is required (8-128 URL-safe characters)', 400);
    }

    if (!isValidAmount(amount) || !destination) {
      return sendError(res, 'A valid amount and destination are required');
    }
    if (!validateAddress(String(destination).trim())) {
      return sendError(res, 'Destination must be a valid Stellar address');
    }

    const user = req.restUser;

    if (!idempotencyKey) {
      const result = await executePayment({
        sender: user,
        destination,
        amount,
        asset: req.body?.asset,
        routeType: req.body?.routeType,
        sourceCountry: req.body?.sourceCountry,
        destinationCountry: req.body?.destinationCountry,
      });
      return sendSuccess(res, {
        transactionId: result.transaction._id || result.transaction.id,
        status: result.transaction.status,
        rail: result.transaction.rail,
        receipt: result.receipt,
      }, 'Payment initiated successfully');
    }

    const fingerprint = fingerprintRequest(req.body);
    const outcome = await idempotencyService.execute({
      userId: user.id,
      key: idempotencyKey,
      fingerprint,
      run: async ({ transactionId }) => {
        const result = await executePayment({
          sender: user,
          destination,
          amount,
          asset: req.body.asset,
          routeType: req.body.routeType,
          sourceCountry: req.body.sourceCountry,
          destinationCountry: req.body.destinationCountry,
          transactionId,
        });
        return {
          transactionId: result.transaction._id,
          status: result.transaction.status,
          rail: result.transaction.rail,
          receipt: result.receipt,
        };
      },
    });

    res.set('Idempotency-Replayed', outcome.replayed ? 'true' : 'false');
    return sendSuccess(res, outcome.response, outcome.replayed ? 'Original payment result replayed' : 'Payment accepted');
  } catch (error) {
    if (error instanceof IdempotencyError) return sendError(res, error.message, error.statusCode);
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

const { buildStatementData, exportStatementCsv, exportStatementPdf } = require('../wallet/statement.service');

const getStatement = async (req, res, next) => {
  try {
    const { startDate, endDate, asset, format = 'json' } = req.query;
    const user = req.restUser;

    if (format === 'csv') {
      const { csv, statementId } = await exportStatementCsv({
        userId: user.id,
        startDate,
        endDate,
        asset,
        actingActor: { type: 'user', id: user.id },
        req,
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="statement-${statementId}.csv"`);
      return res.status(200).send(csv);
    }

    if (format === 'pdf') {
      const { pdfBuffer, statementId } = await exportStatementPdf({
        userId: user.id,
        startDate,
        endDate,
        asset,
        actingActor: { type: 'user', id: user.id },
        req,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="statement-${statementId}.pdf"`);
      return res.status(200).send(pdfBuffer);
    }

    const statement = await buildStatementData({
      userId: user.id,
      startDate,
      endDate,
      asset,
    });

    return sendSuccess(res, statement, 'Account statement generated');
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createWallet,
  checkBalance,
  sendFunds,
  getTransactionHistory,
  getStatement,
};

