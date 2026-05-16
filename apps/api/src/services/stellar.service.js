const { server, StellarSdk } = require('../config/stellar');
const axios = require('axios');
const logger = require('../utils/logger');
const config = require('../config/env');

const createKeypair = () => {
  const keypair = StellarSdk.Keypair.random();
  return {
    publicKey: keypair.publicKey(),
    secretKey: keypair.secret(),
  };
};

const fundAccount = async (publicKey) => {
  try {
    const response = await axios.get(`https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`);
    return response.data;
  } catch (error) {
    logger.error('Error funding account with Friendbot', error.message);
    throw new Error('Failed to fund account on Testnet');
  }
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

const sendXlm = async (secretKey, destination, amount) => {
  try {
    const sourceKeypair = StellarSdk.Keypair.fromSecret(secretKey);
    const sourcePublicKey = sourceKeypair.publicKey();
    
    // Load source account to get current sequence number
    const sourceAccount = await server.loadAccount(sourcePublicKey);
    
    // Check if destination exists
    try {
      await server.loadAccount(destination);
    } catch (e) {
      throw new Error('Destination account does not exist or is not funded.');
    }

    // Build the transaction
    const fee = await server.fetchBaseFee();
    
    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee,
      networkPassphrase: config.stellar.network === 'testnet' ? StellarSdk.Networks.TESTNET : StellarSdk.Networks.PUBLIC,
    })
      .addOperation(StellarSdk.Operation.payment({
        destination,
        asset: StellarSdk.Asset.native(),
        amount: amount.toString(),
      }))
      .setTimeout(30)
      .build();

    // Sign transaction
    transaction.sign(sourceKeypair);

    // Submit transaction
    const response = await server.submitTransaction(transaction);
    return response;
  } catch (error) {
    logger.error('Error sending XLM', error.message);
    throw new Error(error.message || 'Failed to send XLM');
  }
};

module.exports = {
  createKeypair,
  fundAccount,
  getBalance,
  sendXlm,
};
