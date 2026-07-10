// Standalone script. NOT imported by app.js/server.js. Diffs each wallet's
// current on-chain balance against its last known balance and messages the
// user on WhatsApp when a deposit is detected.
//
// Deliberately NOT the worker-process architecture described in
// MAINTAINER.md's "Scaling Note" — that's out of scope here by design. Two
// ways to run this instead:
//
//   1. (Recommended) An external cron (a host's scheduled job, a GitHub
//      Actions scheduled workflow, etc.) triggers:
//        node scripts/notify-deposits.js
//      Safe for any number of app instances — each run is independent.
//
//   2. Set NOTIFY_POLL_ENABLED=true to run an in-process interval instead.
//      This is NOT safe for multi-instance deploys unless the flag is set
//      on exactly one instance — there is no cross-instance coordination
//      here (that coordination is exactly what the Scaling Note describes
//      and this work explicitly does not build).
const mongoose = require('mongoose');
const config = require('../src/config/env');
const Wallet = require('../src/models/Wallet');
const User = require('../src/models/User');
const { resolveAdapter } = require('../src/services/chains');
const { sendTextMessage } = require('../src/services/whatsapp.service');
const logger = require('../src/utils/logger');

const assetLabel = (chain) => (chain === 'lisk' ? 'ETH' : 'XLM');
const chainLabel = (chain) => (chain === 'lisk' ? 'Lisk' : 'Stellar');

// Checks every wallet, not just funded ones — a Lisk wallet stays
// `funded: false` until someone confirms a balance (see handler.js), so
// filtering on `funded` would miss exactly the deposit that should flip it.
const checkWalletForDeposit = async (wallet) => {
  try {
    const currentBalance = await resolveAdapter(wallet.chain).getBalance(wallet.publicKey);
    const previousBalance = Number(wallet.lastKnownBalance || 0);

    if (Number(currentBalance) > previousBalance) {
      const user = await User.findById(wallet.userId);
      if (user) {
        const delta = (Number(currentBalance) - previousBalance).toFixed(7);
        await sendTextMessage(
          user.phoneNumber,
          `You received ${delta} ${assetLabel(wallet.chain)} on ${chainLabel(wallet.chain)}. New balance: ${currentBalance} ${assetLabel(wallet.chain)}.`
        );
      }
    }

    wallet.lastKnownBalance = currentBalance;
    await wallet.save();
  } catch (error) {
    logger.error(`Deposit check failed for wallet ${wallet.publicKey} (${wallet.chain}):`, error.message);
  }
};

const checkAllWallets = async () => {
  const wallets = await Wallet.find({});
  for (const wallet of wallets) {
    await checkWalletForDeposit(wallet);
  }
};

const runOnce = async () => {
  await mongoose.connect(config.mongoUri);
  await checkAllWallets();
  await mongoose.disconnect();
};

if (require.main === module) {
  if (process.env.NOTIFY_POLL_ENABLED === 'true') {
    const intervalMs = Number(process.env.NOTIFY_POLL_INTERVAL_MS || 60000);
    logger.info(`notify-deposits: polling every ${intervalMs}ms (single-instance only — see file header).`);
    mongoose.connect(config.mongoUri).then(() => {
      setInterval(() => {
        checkAllWallets().catch((error) => logger.error('notify-deposits poll failed:', error.message));
      }, intervalMs);
    });
  } else {
    runOnce().catch((error) => {
      console.error('notify-deposits failed:', error.message);
      process.exit(1);
    });
  }
}

module.exports = { checkWalletForDeposit, checkAllWallets };
