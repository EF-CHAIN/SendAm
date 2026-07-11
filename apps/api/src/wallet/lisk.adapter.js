// Lisk (EVM L2) implementation of the chain-adapter interface (see ./chainRegistry.js).
const { ethers } = require('ethers');
const config = require('../config/env');
const logger = require('../utils/logger');

const chain = 'lisk';

// staticNetwork skips ethers' automatic eth_chainId background call on
// construction — without it, merely require()-ing this module fires a
// network request, which breaks unit tests (and startup) with no network
// access. We already know the chain ID from config, so there's nothing to
// detect.
const provider = new ethers.JsonRpcProvider(
  config.lisk.rpcUrl,
  config.lisk.chainId,
  { staticNetwork: true }
);

const createWallet = () => {
  const wallet = ethers.Wallet.createRandom();
  return {
    publicKey: wallet.address,
    secretKey: wallet.privateKey,
  };
};

const validateAddress = (address) => {
  return typeof address === 'string' && ethers.isAddress(address);
};

const getBalance = async (publicKey) => {
  try {
    const wei = await provider.getBalance(publicKey);
    return ethers.formatEther(wei);
  } catch (error) {
    logger.error('Error getting Lisk balance', error.message);
    throw new Error('Could not fetch balance. Check the RPC connection.');
  }
};

// Native asset only for now. Same seam as the Stellar adapter's resolveAsset —
// this is where a future ERC-20 (e.g. bridged USDC) gets mapped by address
// instead of throwing.
const resolveAsset = (asset) => {
  if (!asset || asset === 'ETH' || asset === 'native') {
    return 'native';
  }
  throw new Error(`Unsupported asset: ${asset}`);
};

const submitPayment = async ({ secretKey, destination, amount, asset }) => {
  resolveAsset(asset); // throws on an asset this adapter doesn't support

  if (!validateAddress(destination)) {
    throw new Error('Destination must be a valid Lisk address.');
  }

  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    throw new Error('Amount must be greater than zero.');
  }

  try {
    const signer = new ethers.Wallet(secretKey, provider);
    const tx = await signer.sendTransaction({
      to: destination,
      value: ethers.parseEther(String(amount)),
    });
    const receipt = await tx.wait();
    return {
      txHash: receipt.hash,
      explorerUrl: `${config.lisk.explorerUrl}/tx/${receipt.hash}`,
    };
  } catch (error) {
    logger.error('Error sending Lisk payment', error.message);
    throw new Error(error.shortMessage || error.message || 'Failed to send payment');
  }
};

// Honest limitation: Lisk Sepolia has no Friendbot-equivalent auto-fund API.
// Testnet funding goes through human/device-attestation faucets (Superchain
// Faucet, L2 Faucet), which can't be driven server-side the way Friendbot
// can. Callers must branch on `manual` and surface `instructions` instead of
// assuming the wallet gets funded the way the Stellar side does.
const fundTestnetAccount = async (publicKey) => ({
  funded: false,
  manual: true,
  instructions: `Lisk Sepolia has no automatic funding API. Fund ${publicKey} manually via the Superchain Faucet (https://console.optimism.io/faucet) or another Lisk Sepolia faucet, then send 'fund' again to check.`,
});

module.exports = {
  chain,
  createWallet,
  getBalance,
  submitPayment,
  resolveAsset,
  validateAddress,
  fundTestnetAccount,
};
