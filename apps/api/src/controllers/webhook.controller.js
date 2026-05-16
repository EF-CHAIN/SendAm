const { parseCommand } = require('../services/parser.service');
const { sendTextMessage } = require('../services/whatsapp.service');
const { createWalletForUser, getWalletByUserId } = require('../services/wallet.service');
const { getBalance, sendXlm, fundAccount } = require('../services/stellar.service');
const { decrypt } = require('../services/crypto.service');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');

const handleIncomingMessage = async (req, res) => {
  // Always return 200 OK immediately to WhatsApp to prevent retries
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const messages = value?.messages;
      const contacts = value?.contacts;

      if (messages && messages.length > 0) {
        const message = messages[0];
        const contact = contacts?.[0];
        
        const from = message.from; // Phone number
        const whatsappName = contact?.profile?.name || '';
        
        if (message.type === 'text') {
          const text = message.text.body;
          
          // Process command asynchronously
          processCommand(from, whatsappName, text).catch(err => {
            logger.error(`Error processing command for ${from}:`, err);
            sendTextMessage(from, `Sorry, an error occurred: ${err.message}`);
          });
        }
      }
    }
  } catch (error) {
    logger.error('Webhook processing error:', error);
  }
};

const processCommand = async (phoneNumber, whatsappName, text) => {
  // Find or create user
  let user = await User.findOne({ phoneNumber });
  if (!user) {
    user = await User.create({ phoneNumber, whatsappName });
  } else if (whatsappName && user.whatsappName !== whatsappName) {
    user.whatsappName = whatsappName;
    await user.save();
  }

  const command = parseCommand(text);

  switch (command.type) {
    case 'GREETING':
      await sendTextMessage(phoneNumber, `Hello ${whatsappName}! Welcome to SendAm. Reply with 'help' to see available commands.`);
      break;

    case 'HELP':
      const helpMsg = `Available commands:\n- 'create wallet' : Create a new Stellar wallet\n- 'balance' : Check your XLM balance\n- 'send <amount> xlm <address>' : Send XLM to an address\n\nExample: send 5 xlm GABC...`;
      await sendTextMessage(phoneNumber, helpMsg);
      break;

    case 'CREATE_WALLET':
      try {
        const wallet = await createWalletForUser(user._id);
        await sendTextMessage(phoneNumber, `Creating and funding your new wallet on Stellar Testnet...`);
        
        // Fund on testnet
        await fundAccount(wallet.publicKey);
        
        await sendTextMessage(phoneNumber, `✅ Wallet created and funded successfully!\n\nYour Public Key:\n${wallet.publicKey}\n\nYou can now check your 'balance'.`);
      } catch (error) {
        if (error.message === 'User already has a wallet') {
          const existingWallet = await getWalletByUserId(user._id);
          await sendTextMessage(phoneNumber, `You already have a wallet.\n\nYour Public Key:\n${existingWallet.publicKey}`);
        } else {
          throw error;
        }
      }
      break;

    case 'BALANCE':
      try {
        const wallet = await getWalletByUserId(user._id);
        if (!wallet) {
          await sendTextMessage(phoneNumber, `You don't have a wallet yet. Send 'create wallet' first.`);
          return;
        }
        
        const balance = await getBalance(wallet.publicKey);
        await sendTextMessage(phoneNumber, `💰 Your current balance is ${balance} XLM`);
      } catch (error) {
        await sendTextMessage(phoneNumber, `❌ Error getting balance: ${error.message}`);
      }
      break;

    case 'SEND_XLM':
      try {
        const wallet = await getWalletByUserId(user._id);
        if (!wallet) {
          await sendTextMessage(phoneNumber, `You don't have a wallet yet. Send 'create wallet' first.`);
          return;
        }

        const { amount, destination } = command.payload;
        
        await sendTextMessage(phoneNumber, `⏳ Processing your transfer of ${amount} XLM to ${destination.substring(0, 8)}...`);

        const secretKey = decrypt(wallet.encryptedSecretKey);
        const txResponse = await sendXlm(secretKey, destination, amount);

        // Record transaction
        await Transaction.create({
          userId: user._id,
          type: 'send',
          amount,
          asset: 'XLM',
          destination,
          txHash: txResponse.hash,
          status: 'success'
        });

        await sendTextMessage(phoneNumber, `✅ Transfer successful!\nTransaction ID: ${txResponse.hash}`);
      } catch (error) {
        // Record failed transaction
        await Transaction.create({
          userId: user._id,
          type: 'send',
          amount: command.payload?.amount || '0',
          destination: command.payload?.destination || 'unknown',
          status: 'failed'
        });
        
        await sendTextMessage(phoneNumber, `❌ Transfer failed: ${error.message}`);
      }
      break;

    case 'INVALID_SEND':
      await sendTextMessage(phoneNumber, `Invalid send format. Please use: 'send <amount> xlm <address>'\nExample: send 5 xlm GABC...`);
      break;

    default:
      await sendTextMessage(phoneNumber, `Sorry, I didn't understand that. Reply with 'help' to see what I can do.`);
  }
};

module.exports = {
  handleIncomingMessage
};
