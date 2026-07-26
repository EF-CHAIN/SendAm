const logger = require('../utils/logger');
const { server } = require('../config/stellar');
const { getTransactionUrl } = require('../wallet/stellar.adapter');

// Reconciles stuck transactions in 'processing' or 'pending' state by querying Horizon.
const reconcileStaleTransactions = async ({
  prisma,
  staleAgeMs = 5 * 60 * 1000, // 5 minutes
  maxTransactions = 50,
  horizonServer = server,
  loggerInstance = logger,
} = {}) => {
  const cutoff = new Date(Date.now() - staleAgeMs);

  const staleTransactions = await prisma.transaction.findMany({
    where: {
      status: { in: ['processing', 'pending'] },
      createdAt: { lte: cutoff },
    },
    take: maxTransactions,
    include: {
      user: {
        include: {
          wallets: {
            where: { chain: 'stellar' },
          },
        },
      },
    },
  });

  if (staleTransactions.length === 0) {
    return { processedCount: 0, updatedCount: 0 };
  }

  let updatedCount = 0;

  for (const tx of staleTransactions) {
    try {
      // 1. Check if txHash exists and is confirmed on Horizon
      if (tx.txHash) {
        try {
          const horizonTx = await horizonServer.transactions().transactionHash(tx.txHash).call();
          if (horizonTx && horizonTx.successful) {
            await prisma.transaction.update({
              where: { id: tx.id },
              data: {
                status: 'success',
                explorerUrl: getTransactionUrl(tx.txHash),
              },
            });
            updatedCount += 1;
            loggerInstance.info(`Reconciled transaction ${tx.id} to success via txHash ${tx.txHash}`);
            continue;
          }
        } catch (err) {
          if (err.response?.status !== 404) {
            loggerInstance.warn(`Horizon error checking txHash ${tx.txHash} for tx ${tx.id}: ${err.message}`);
          }
        }
      }

      // 2. Query sender wallet's payments on Horizon if wallet address is available
      const senderPublicKey = tx.user?.wallets?.[0]?.publicKey;
      if (senderPublicKey) {
        try {
          const paymentsResponse = await horizonServer.payments().forAccount(senderPublicKey).order('desc').limit(20).call();
          const matchingPayment = paymentsResponse.records.find((p) => {
            const isPayment = p.type === 'payment';
            const amountMatches = String(p.amount) === String(tx.amount);
            const toMatches = !tx.destination || p.to === tx.destination;
            return isPayment && amountMatches && toMatches;
          });

          if (matchingPayment) {
            const hash = matchingPayment.transaction_hash;
            await prisma.transaction.update({
              where: { id: tx.id },
              data: {
                status: 'success',
                txHash: hash,
                explorerUrl: getTransactionUrl(hash),
              },
            });
            updatedCount += 1;
            loggerInstance.info(`Reconciled transaction ${tx.id} to success via payment history match on ${senderPublicKey}`);
            continue;
          }
        } catch (err) {
          loggerInstance.warn(`Horizon error checking payment history for account ${senderPublicKey}: ${err.message}`);
        }
      }

      // 3. Mark failed if stale age is exceeded (e.g. > 15 mins) and no Horizon match found
      const maxStaleCutoff = new Date(Date.now() - staleAgeMs * 3);
      if (tx.createdAt <= maxStaleCutoff) {
        await prisma.transaction.update({
          where: { id: tx.id },
          data: {
            status: 'failed',
            metadata: {
              ...tx.metadata,
              reconciliationError: 'Transaction timed out without on-chain settlement.',
            },
          },
        });
        updatedCount += 1;
        loggerInstance.info(`Reconciled stale transaction ${tx.id} to failed after timeout`);
      }
    } catch (err) {
      loggerInstance.error(`Error reconciling transaction ${tx.id}`, err.message);
    }
  }

  return { processedCount: staleTransactions.length, updatedCount };
};

module.exports = { reconcileStaleTransactions };
