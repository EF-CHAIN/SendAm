// Standalone spike. NOT imported by app.js/server.js, NOT an HTTP route,
// NOT wired into the WhatsApp bot. Run manually:
//
//   node scripts/bridge-spike.js
//
// What this proves: the Stellar leg of "bridge value into Stellar USDC" is
// real and reachable — it fetches a live quote from Allbridge Core's
// production API. What it deliberately does NOT do: move any funds, or
// bridge from Lisk specifically. Three real constraints, all confirmed
// live against the installed SDK and its API — not assumed (see
// bridge.adapter.js for detail):
//
//   1. Allbridge Core does not support Lisk as a chain at all.
//   2. Allbridge Core has no testnet — only a live quote is safe to run
//      here. Actual execution would be real mainnet money and is not
//      attempted by this script.
//   3. The USDC this bridges into lives on Soroban, not classic Stellar —
//      SendAm's existing wallet flow doesn't talk to Soroban yet, so a
//      further integration step is needed before bridged funds are usable
//      the way native XLM is today.
const mongoose = require('mongoose');
const config = require('../src/config/env');
const { ChainSymbol, quoteToStellarUsdc } = require('../src/services/chains/bridge.adapter');
const BridgeLedgerEntry = require('../src/models/BridgeLedgerEntry');

const SPIKE_AMOUNT = '10'; // USDC, arbitrary demo amount — nothing is sent

const run = async () => {
  console.log('--- SendAm bridge groundwork spike ---');
  console.log('Lisk leg: NOT SUPPORTED by Allbridge Core (no LISK ChainSymbol). Not attempted.');
  console.log(`Quoting the real, supported route instead: Ethereum USDC -> Stellar USDC (amount: ${SPIKE_AMOUNT})\n`);

  const { sourceToken, destinationToken, amountToBeReceived } = await quoteToStellarUsdc({
    fromChainSymbol: ChainSymbol.ETH,
    amount: SPIKE_AMOUNT,
    messenger: require('@allbridge/bridge-core-sdk').Messenger.ALLBRIDGE,
  });

  console.log('Live quote received from Allbridge Core:');
  console.log(`  Source:      ${SPIKE_AMOUNT} ${sourceToken.symbol} on ${sourceToken.chainSymbol} (${sourceToken.tokenAddress})`);
  console.log(`  Destination: ${destinationToken.symbol} on ${destinationToken.chainSymbol} (${destinationToken.tokenAddress}) — Soroban, not classic Stellar`);
  console.log(`  Amount to be received: ${JSON.stringify(amountToBeReceived)}`);

  await mongoose.connect(config.mongoUri);
  const entry = await BridgeLedgerEntry.create({
    fromChain: 'lisk', // aspirational label — see notes; the quote above ran on Ethereum, the only real proof available today
    toChain: 'stellar',
    sourceAddress: 'spike-script-no-real-address',
    destinationAddress: 'spike-script-no-real-address',
    amountIn: SPIKE_AMOUNT,
    amountOut: typeof amountToBeReceived === 'string' ? amountToBeReceived : JSON.stringify(amountToBeReceived),
    status: 'observed',
    notes: 'Groundwork spike only. Quoted via Ethereum (the real, supported chain) as a stand-in for Lisk, which Allbridge Core does not support. Destination is Soroban USDC, not classic Stellar. No funds moved. Not wired into the live bot.',
  });
  console.log(`\nLogged audit entry ${entry._id} to BridgeLedgerEntry (status: observed).`);

  await mongoose.disconnect();
  console.log('\n--- Done. No funds were moved. This mechanism is not wired into the live bot. ---');
};

run().catch((error) => {
  console.error('Bridge spike failed:', error.message);
  process.exit(1);
});
