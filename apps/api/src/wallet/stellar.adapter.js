// Stellar implementation of the chain-adapter interface (see ./chainRegistry.js).
const { server, StellarSdk } = require('../config/stellar');
const axios = require('axios');
const logger = require('../utils/logger');
const config = require('../config/env');

const chain = 'stellar';

const createWallet = () => {
  const keypair = StellarSdk.Keypair.random();
  return {
    publicKey: keypair.publicKey(),
    secretKey: keypair.secret(),
  };
};

const validateAddress = (address) => {
  return typeof address === 'string' && StellarSdk.StrKey.isValidEd25519PublicKey(address);
};

const getTransactionUrl = (txHash) => {
  const network = config.stellar.network === 'testnet' ? 'testnet' : 'public';
  return `https://stellar.expert/explorer/${network}/tx/${txHash}`;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FUNDING_MAX_ATTEMPTS = 3;

// Friendbot is unreliable (frequent 5xx/timeouts), and a failed first-time
// funding used to leave a user with an empty wallet and no way to recover.
// Retry with linear backoff, and treat "account already exists" as success so
// re-running create/`fund` on an already-funded wallet is idempotent.
const fundTestnetAccount = async (publicKey) => {
  let lastError;
  for (let attempt = 1; attempt <= FUNDING_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await axios.get(`https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`);
      return { funded: true, data: response.data };
    } catch (error) {
      const body = JSON.stringify(error.response?.data || '');
      if (error.response?.status === 400 && /op_already_exists|already.*exist/i.test(body)) {
        logger.info(`Account ${publicKey} already funded; treating Friendbot 400 as success.`);
        return { funded: true, alreadyFunded: true };
      }
      lastError = error;
      logger.warn(`Friendbot funding attempt ${attempt}/${FUNDING_MAX_ATTEMPTS} for ${publicKey} failed: ${error.message}`);
      if (attempt < FUNDING_MAX_ATTEMPTS) {
        await sleep(attempt * 500);
      }
    }
  }
  logger.error('Error funding account with Friendbot', lastError?.message);
  throw new Error('Failed to fund account on Testnet');
};

const getBalance = async (publicKey) => {
  try {
    const account = await server.loadAccount(publicKey);
    const xlmBalance = account.balances.find((b) => b.asset_type === 'native');
    return xlmBalance ? xlmBalance.balance : '0';
  } catch (error) {
    logger.error('Error getting balance', error.message);
    throw new Error('Could not fetch balance. Check if account is funded.');
  }
};

// Resolve an asset code to a Stellar SDK Asset. Native XLM is the only
// asset wired today; this is the seam where future assets (e.g. USDC and
// other anchor-issued assets used by on/off-ramps and swaps) get added by
// mapping a code+issuer instead of throwing.
const resolveAsset = (asset) => {
  if (!asset || asset === 'XLM' || asset === 'native') {
    return StellarSdk.Asset.native();
  }
  throw new Error(`Unsupported asset: ${asset}`);
};

const SEND_MAX_ATTEMPTS = 3;

// A transaction is built against the source account's current sequence number.
// If two sends from the same account race (e.g. two confirmed transfers near
// the same moment), the second submits with a stale sequence and Horizon
// rejects it with tx_bad_seq. Detect that specific failure so we can reload the
// account and resubmit, rather than surfacing a confusing error to the user.
const isBadSequence = (error) => {
  const codes = error?.response?.data?.extras?.result_codes;
  return codes?.transaction === 'tx_bad_seq';
};

const submitPayment = async ({ secretKey, destination, amount, asset = 'XLM' }) => {
  try {
    if (!validateAddress(destination)) {
      throw new Error('Destination must be a valid Stellar public key.');
    }

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      throw new Error('Amount must be greater than zero.');
    }

    const sourceKeypair = StellarSdk.Keypair.fromSecret(secretKey);
    const sourcePublicKey = sourceKeypair.publicKey();

    // Check if destination exists (once; this doesn't change between retries).
    try {
      await server.loadAccount(destination);
    } catch (e) {
      throw new Error('Destination account does not exist or is not funded.');
    }

    const fee = await server.fetchBaseFee();
    const networkPassphrase = config.stellar.network === 'testnet'
      ? StellarSdk.Networks.TESTNET
      : StellarSdk.Networks.PUBLIC;

    // Reload the account (fresh sequence), rebuild, sign, and submit on each
    // attempt. Retry only on tx_bad_seq — any other failure is terminal.
    let lastError;
    for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt += 1) {
      const sourceAccount = await server.loadAccount(sourcePublicKey);

      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee,
        networkPassphrase,
      })
        .addOperation(StellarSdk.Operation.payment({
          destination,
          asset: resolveAsset(asset),
          amount: amount.toString(),
        }))
        .setTimeout(30)
        .build();

      transaction.sign(sourceKeypair);

      try {
        const txResponse = await server.submitTransaction(transaction);
        return { txHash: txResponse.hash, explorerUrl: getTransactionUrl(txResponse.hash) };
      } catch (error) {
        if (isBadSequence(error) && attempt < SEND_MAX_ATTEMPTS) {
          lastError = error;
          logger.warn(`Payment hit tx_bad_seq (attempt ${attempt}/${SEND_MAX_ATTEMPTS}); reloading sequence and retrying.`);
          await sleep(attempt * 250);
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error('Failed to send payment');
  } catch (error) {
    logger.error('Error sending payment', error.message);
    throw new Error(error.message || 'Failed to send payment');
  }
};

module.exports = {
  chain,
  createWallet,
  getBalance,
  submitPayment,
  resolveAsset,
  validateAddress,
  fundTestnetAccount,
  getTransactionUrl,
};
