// Stellar leg of a Lisk -> Stellar USDC bridge, via the real Allbridge Core
// SDK (@allbridge/bridge-core-sdk). See ARCHITECTURE.md and MAINTAINER.md
// for why this exists. Two real constraints shape this file — confirmed
// against the installed SDK itself, not assumed:
//
//   1. Allbridge Core has no Lisk entry in its ChainSymbol enum (checked in
//      node_modules/@allbridge/bridge-core-sdk/dist/src/chains/chain.enums.d.ts —
//      BSC, ETH, BAS, SOL, TRX, POL, ARB, CEL, AVA, SRB, STLR, OPT, SUI, SNC,
//      UNI, LIN, ALG, STX. No LISK, despite Lisk being an OP-Stack chain like
//      Base/Optimism, both of which ARE supported). A Lisk leg needs either
//      Allbridge adding Lisk support, or a two-hop route (Lisk -> Ethereum via
//      Lisk's native OP-Stack canonical bridge -> Ethereum -> Stellar via
//      Allbridge, since Ethereum is supported). Neither is implemented here.
//
//   2. Allbridge Core ships only a `mainnet` config — no testnet preset
//      exists, and its README has zero mentions of testnet. There is no safe
//      testnet version of this bridge to execute real transfers against.
//      Quoting (read-only, moves nothing) is real and safe to call. Actually
//      initiating a transfer is real mainnet activity with real funds, and
//      is deliberately not exercised anywhere in this codebase's automated
//      paths — see initiateBridgeToStellarUsdc below.
//
//   3. Allbridge Core's "Stellar" USDC actually lives on the Soroban
//      (smart-contract) side, not classic Stellar — verified live:
//      sdk.tokensByChain(ChainSymbol.STLR) returns an empty token list;
//      sdk.tokensByChain(ChainSymbol.SRB) returns USDC. SendAm's existing
//      Stellar integration (stellar.adapter.js) is classic-Stellar
//      (Horizon accounts, StellarSdk.Asset/trustlines) — it does not talk
//      to Soroban contracts. So bridged USDC lands as a Soroban token, not
//      directly usable by the existing wallet flow without an additional
//      Soroban-side integration step (a separate, not-yet-built piece of
//      work — flagged here rather than silently assumed away).
const { AllbridgeCoreSdk, ChainSymbol, mainnet } = require('@allbridge/bridge-core-sdk');

let sdk;
const getSdk = () => {
  if (!sdk) {
    // Empty nodeUrls: node RPC URLs are only required for SOL/TRX per the
    // SDK's own docs, and this adapter only touches the Stellar (STLR) leg.
    sdk = new AllbridgeCoreSdk({}, mainnet);
  }
  return sdk;
};

const findUsdcToken = async (chainSymbol) => {
  const tokens = await getSdk().tokensByChain(chainSymbol);
  const usdc = tokens.find((t) => t.symbol === 'USDC');
  if (!usdc) {
    throw new Error(`No USDC token found on ${chainSymbol} via Allbridge Core`);
  }
  return usdc;
};

/**
 * Real, read-only quote for bridging a USDC-denominated amount from another
 * Allbridge-supported chain into Stellar USDC. Safe to call in any
 * environment — fetches live pricing/route data from Allbridge's Core API
 * and moves nothing.
 */
const quoteToStellarUsdc = async ({ fromChainSymbol, amount, messenger }) => {
  const [sourceToken, destinationToken] = await Promise.all([
    findUsdcToken(fromChainSymbol),
    findUsdcToken(ChainSymbol.SRB), // Soroban — see constraint #3 above
  ]);
  const amountToBeReceived = await getSdk().getAmountToBeReceived(amount, sourceToken, destinationToken, messenger);
  return { sourceToken, destinationToken, amountToBeReceived };
};

/**
 * Deliberately not wired into anything automated. Allbridge Core has no
 * testnet, so actually calling this would move real funds on mainnet. The
 * calling shape (sdk.bridge.send / sdk.bridge.rawTxBuilder) is real, but
 * the Stellar-side Provider (transaction signer) still needs to be
 * constructed and reviewed before this is safe to invoke from anything
 * automated — left as a documented seam, not a fake implementation.
 */
const initiateBridgeToStellarUsdc = async () => {
  throw new Error(
    'Not implemented: Allbridge Core has no testnet, so executing this requires ' +
    'a real, deliberately-constructed Stellar Provider and real mainnet funds. ' +
    'Do not wire this into any automated flow without that groundwork and explicit review.'
  );
};

module.exports = {
  ChainSymbol,
  quoteToStellarUsdc,
  initiateBridgeToStellarUsdc,
};
