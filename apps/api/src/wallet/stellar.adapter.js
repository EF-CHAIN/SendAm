// Stellar wallet adapter — keypair creation, Friendbot funding, balance,
// and payment submission. The only chain SDK integration in the codebase.
const { server, StellarSdk } = require("../config/stellar");
const { isHorizonWriteUncertain } = require("../config/horizon");
const axios = require("axios");
const logger = require("../utils/logger");
const config = require("../config/env");
const { assertValidAmount } = require("../utils/money");
const { outboundHeaders } = require("../observability/context");

const chain = "stellar";

const createWallet = () => {
  const keypair = StellarSdk.Keypair.random();
  return {
    publicKey: keypair.publicKey(),
    secretKey: keypair.secret(),
  };
};

const validateAddress = (address) => {
  return (
    typeof address === "string" &&
    (StellarSdk.StrKey.isValidEd25519PublicKey(address) ||
      StellarSdk.StrKey.isValidMed25519PublicKey(address))
  );
};

const isMuxedAddress = (address) => {
  return (
    typeof address === "string" &&
    StellarSdk.StrKey.isValidMed25519PublicKey(address)
  );
};

const getBaseAccountId = (destination) => {
  if (isMuxedAddress(destination)) {
    const decoded = StellarSdk.StrKey.decodeMed25519PublicKey(destination);
    return StellarSdk.StrKey.encodeEd25519PublicKey(decoded.slice(0, 32));
  }
  return destination;
};

const validateMemo = ({ memo, memoType = "text" }) => {
  if (memo === undefined || memo === null || memo === "") return true;
  const type = String(memoType || "text").toLowerCase();
  if (!["text", "id", "hash", "return"].includes(type)) {
    throw new Error(`Unsupported memo type: ${memoType}. Must be text, id, hash, or return.`);
  }
  if (type === "text") {
    if (Buffer.byteLength(String(memo), "utf8") > 28) {
      throw new Error("Invalid text memo: maximum 28 bytes allowed.");
    }
  } else if (type === "id") {
    const str = String(memo).trim();
    if (!/^\d+$/.test(str)) {
      throw new Error("Invalid id memo: must be a numeric integer string.");
    }
    try {
      const val = BigInt(str);
      if (val < 0n || val > 18446744073709551615n) {
        throw new Error("Invalid id memo: must fit in an unsigned 64-bit integer.");
      }
    } catch (_e) {
      throw new Error("Invalid id memo: must fit in an unsigned 64-bit integer.");
    }
  } else if (type === "hash" || type === "return") {
    if (Buffer.isBuffer(memo)) {
      if (memo.length !== 32) {
        throw new Error(`Invalid ${type} memo: Buffer must be 32 bytes.`);
      }
    } else if (typeof memo === "string") {
      const hex = memo.trim();
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error(`Invalid ${type} memo: must be a 32-byte hex string (64 characters).`);
      }
    } else {
      throw new Error(`Invalid ${type} memo: must be a 32-byte hex string or Buffer.`);
    }
  }
  return true;
};

const buildStellarMemo = ({ memo, memoType = "text" }) => {
  if (memo === undefined || memo === null || memo === "") return null;
  validateMemo({ memo, memoType });
  const type = String(memoType || "text").toLowerCase();
  if (type === "text") return StellarSdk.Memo.text(String(memo));
  if (type === "id") return StellarSdk.Memo.id(String(memo).trim());
  if (type === "hash") {
    const buf = Buffer.isBuffer(memo) ? memo : Buffer.from(String(memo).trim(), "hex");
    return StellarSdk.Memo.hash(buf);
  }
  if (type === "return") {
    const buf = Buffer.isBuffer(memo) ? memo : Buffer.from(String(memo).trim(), "hex");
    return StellarSdk.Memo.return(buf);
  }
  return null;
};

const redactMemo = (memo) => {
  if (memo === undefined || memo === null || memo === "") return "";
  const str = String(memo);
  if (str.length <= 4) return "****";
  return `${str.slice(0, 2)}***${str.slice(-2)}`;
};

const getTransactionUrl = (txHash) => {
  const network = config.stellar.network === "testnet" ? "testnet" : "public";
  return `https://stellar.expert/explorer/${network}/tx/${txHash}`;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FUNDING_MAX_ATTEMPTS = 3;
const NATIVE_BASE_RESERVE = Number(process.env.STELLAR_BASE_RESERVE_XLM || 0.5);
const NATIVE_RESERVE_BUFFER = Number(process.env.STELLAR_RESERVE_BUFFER_XLM || 0.1);

function assertNativeReserve(account, feeStroops, additionalSubentries = 0) {
  const native = account.balances.find((balance) => balance.asset_type === 'native');
  const available = Number(native?.balance || 0);
  const subentries = Number(account.subentry_count || 0) + additionalSubentries;
  const required = NATIVE_BASE_RESERVE * (2 + subentries)
    + NATIVE_RESERVE_BUFFER + Number(feeStroops || 0) / 1e7;
  if (!Number.isFinite(available) || available < required) {
    throw new Error(
      `Insufficient XLM reserve. Keep at least ${required.toFixed(7)} XLM for account reserve and fees, then retry.`,
    );
  }
  return { available, required };
}

// Friendbot is unreliable (frequent 5xx/timeouts), and a failed first-time
// funding used to leave a user with an empty wallet and no way to recover.
// Retry with linear backoff, and treat "account already exists" as success so
// re-running create/`fund` on an already-funded wallet is idempotent.
const fundTestnetAccount = async (publicKey) => {
  if (config.stellar.isMainnet) {
    throw new Error(
      'Friendbot funding is not available on mainnet. '
      + 'Fund the account with real XLM before submitting transactions.',
    );
  }

  let lastError;
  for (let attempt = 1; attempt <= FUNDING_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await axios.get(
        `https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`,
        { headers: outboundHeaders() },
      );
      return { funded: true, data: response.data };
    } catch (error) {
      const body = JSON.stringify(error.response?.data || "");
      if (
        error.response?.status === 400 &&
        /op_already_exists|already.*exist/i.test(body)
      ) {
        logger.info(
          `Account ${publicKey} already funded; treating Friendbot 400 as success.`,
        );
        return { funded: true, alreadyFunded: true };
      }
      lastError = error;
      logger.warn(
        `Friendbot funding attempt ${attempt}/${FUNDING_MAX_ATTEMPTS} for ${publicKey} failed: ${error.message}`,
      );
      if (attempt < FUNDING_MAX_ATTEMPTS) {
        await sleep(attempt * 500);
      }
    }
  }
  logger.error("Error funding account with Friendbot", lastError?.message);
  throw new Error("Failed to fund account on Testnet");
};

const getBalance = async (publicKey) => {
  try {
    const account = await server.loadAccount(publicKey);
    const xlmBalance = account.balances.find((b) => b.asset_type === "native");
    return xlmBalance ? xlmBalance.balance : "0";
  } catch (error) {
    logger.error("Error getting balance", error.message);
    throw new Error("Could not fetch balance. Check if account is funded.");
  }
};

// Every relevant balance for a wallet: XLM plus USDC when the account holds
// a trustline for it. Horizon lists all trustlines regardless of issuer, so
// USDC is only reported when both the asset code *and* the configured
// issuer match — a same-code trustline from another issuer is a different,
// unrelated asset and must not be surfaced as USDC.
const getBalances = async (publicKey) => {
  try {
    const account = await server.loadAccount(publicKey);
    const balances = [];

    const xlmBalance = account.balances.find((b) => b.asset_type === "native");
    balances.push({
      asset: "XLM",
      value: xlmBalance ? xlmBalance.balance : "0",
    });

    const usdcBalance = account.balances.find(
      (b) =>
        b.asset_code === "USDC" && b.asset_issuer === config.stellar.usdcIssuer,
    );
    if (usdcBalance) {
      balances.push({ asset: "USDC", value: usdcBalance.balance });
    }

    return balances;
  } catch (error) {
    logger.error("Error getting balances", error.message);
    throw new Error("Could not fetch balances. Check if account is funded.");
  }
};

// Resolve an asset code to a Stellar SDK Asset. Native XLM is the only
// asset wired today; this is the seam where future assets (e.g. USDC and
// other anchor-issued assets used by on/off-ramps and swaps) get added by
// mapping a code+issuer instead of throwing.
const resolveAsset = (asset) => {
  if (!asset || asset === "XLM" || asset === "native") {
    return StellarSdk.Asset.native();
  }
  if (asset === 'USDC') {
    return new StellarSdk.Asset('USDC', config.stellar.usdcIssuer);
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
  return codes?.transaction === "tx_bad_seq";
};

// Best-effort hash extraction from a built transaction (used to verify a
// submission whose response was lost to a timeout).
const safeHash = (transaction) => {
  try {
    const hash = transaction.hash();
    return typeof hash === "string" ? hash : hash.toString("hex");
  } catch {
    return null;
  }
};

const getFriendlyPaymentError = (error) => {
  const codes = error?.response?.data?.extras?.result_codes;

  if (codes?.operations?.includes("op_no_trust")) {
    return "The recipient can't receive USDC yet.";
  }

  if (codes?.operations?.includes("op_underfunded")) {
    return "Insufficient balance for this payment.";
  }

  return null;
};

const submitPayment = async ({
  secretKey,
  destination,
  amount,
  asset = "XLM",
  memo,
  memoType,
}) => {
  try {
    if (!validateAddress(destination)) {
      throw new Error("Destination must be a valid Stellar public key or muxed address.");
    }

    if (isMuxedAddress(destination) && memo !== undefined && memo !== null && memo !== "") {
      throw new Error("Muxed account destination already includes an embedded ID; providing a separate memo is conflicting.");
    }

    if (memo !== undefined && memo !== null && memo !== "") {
      validateMemo({ memo, memoType });
    }

    const normalizedAmount = assertValidAmount(amount, asset);

    const sourceKeypair = StellarSdk.Keypair.fromSecret(secretKey);
    const sourcePublicKey = sourceKeypair.publicKey();

    const baseDestination = getBaseAccountId(destination);

    // Check if destination exists (once; this doesn't change between retries).
    try {
      await server.loadAccount(baseDestination);
    } catch (_e) {
      throw new Error("Destination account does not exist or is not funded.");
    }

    const fee = await server.fetchBaseFee();
    const networkPassphrase =
      config.stellar.network === "testnet"
        ? StellarSdk.Networks.TESTNET
        : StellarSdk.Networks.PUBLIC;

    const stellarMemo = buildStellarMemo({ memo, memoType });

    let transaction;
    let hash;
    let lastError;
    for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt += 1) {
      const sourceAccount = await server.loadAccount(sourcePublicKey);
      assertNativeReserve(sourceAccount, fee);

      const builder = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee,
        networkPassphrase,
      }).addOperation(
        StellarSdk.Operation.payment({
          destination,
          asset: resolveAsset(asset),
          amount: normalizedAmount,
        }),
      );

      if (stellarMemo) {
        builder.addMemo(stellarMemo);
      }

        if (stellarMemo) {
          builder.addMemo(stellarMemo);
        }

        transaction = builder.setTimeout(30).build();
        transaction.sign(sourceKeypair);
        hash = safeHash(transaction);
      }

      try {
        const txResponse = await server.submitTransaction(transaction);
        return {
          txHash: txResponse.hash,
          explorerUrl: getTransactionUrl(txResponse.hash),
        };
      } catch (error) {
        if (isHorizonWriteUncertain(error)) {
          if (hash) {
            try {
              const found = await server.transactions().transactionHash(hash).call();
              if (found) {
                logger.info(`Recovered seemingly-timed-out payment ${hash} via Horizon lookup.`);
                return { txHash: hash, explorerUrl: getTransactionUrl(hash) };
              }
            } catch (_) {
              // Ignore lookup errors
            }
          }

          if (attempt < SEND_MAX_ATTEMPTS) {
            logger.warn(`Payment uncertain (attempt ${attempt}/${SEND_MAX_ATTEMPTS}); resubmitting same envelope.`);
            await sleep(attempt * 250);
            continue;
          } else {
            throw new Error(
              "Transaction submission status unknown after timeout; not resubmitting to avoid a duplicate.",
            );
          }
        }

        if (isBadSequence(error)) {
          if (hash) {
            try {
              const found = await server.transactions().transactionHash(hash).call();
              if (found) {
                logger.info(`Recovered tx_bad_seq payment ${hash} via Horizon lookup.`);
                return { txHash: hash, explorerUrl: getTransactionUrl(hash) };
              }
            } catch (_) {
            }
          }

          if (attempt < SEND_MAX_ATTEMPTS) {
            lastError = error;
            logger.warn(
              `Payment hit tx_bad_seq (attempt ${attempt}/${SEND_MAX_ATTEMPTS}); reloading sequence and retrying.`,
            );
            transaction = null;
            await sleep(attempt * 250);
            continue;
          }
        }

        const friendlyMessage = getFriendlyPaymentError(error);
        if (friendlyMessage) {
          throw new Error(friendlyMessage);
        }

        throw error;
      }
    }

    throw lastError || new Error("Failed to send payment");
  } catch (error) {
    logger.error("Error sending payment", error.message);
    throw new Error(error.message || "Failed to send payment");
  }
};

// Open a trustline so the wallet can hold an issued asset (e.g. USDC). This is
// a `changeTrust` operation the wallet signs for itself, and it costs one XLM
// reserve entry (see docs/STELLAR.md). Idempotent: callers may retry freely, so
// if the trustline already exists we report that without submitting anything.
const establishTrustline = async ({ secretKey, assetCode }) => {
  const sourceKeypair = StellarSdk.Keypair.fromSecret(secretKey);
  const sourcePublicKey = sourceKeypair.publicKey();

  const asset = resolveAsset(assetCode);
  if (asset.isNative()) {
    throw new Error("XLM is the native asset and needs no trustline.");
  }

  // An unfunded (nonexistent) account 404s here; surface a clear reason rather
  // than a raw Horizon error dump.
  let account;
  try {
    account = await server.loadAccount(sourcePublicKey);
  } catch (error) {
    logger.error("Error loading account for trustline", error.message);
    throw new Error(
      "Account is not funded yet — fund it before opening a trustline.",
    );
  }

  // Already trusted (same code *and* issuer): no-op, safe to call repeatedly.
  const alreadyExisted = account.balances.some(
    (b) =>
      b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer(),
  );
  if (alreadyExisted) {
    return { established: true, alreadyExisted: true };
  }

  const fee = await server.fetchBaseFee();
  assertNativeReserve(account, fee, 1);
  const networkPassphrase =
    config.stellar.network === "testnet"
      ? StellarSdk.Networks.TESTNET
      : StellarSdk.Networks.PUBLIC;

  const transaction = new StellarSdk.TransactionBuilder(account, {
    fee,
    networkPassphrase,
  })
    .addOperation(StellarSdk.Operation.changeTrust({ asset }))
    .setTimeout(30)
    .build();

  transaction.sign(sourceKeypair);

  try {
    const txResponse = await server.submitTransaction(transaction);
    return {
      established: true,
      alreadyExisted: false,
      txHash: txResponse.hash,
      explorerUrl: getTransactionUrl(txResponse.hash),
    };
  } catch (error) {
    logger.error("Error establishing trustline", error.message);
    throw new Error(`Could not establish ${asset.getCode()} trustline.`);
  }
};

module.exports = {
  chain,
  createWallet,
  getBalance,
  getBalances,
  submitPayment,
  establishTrustline,
  assertNativeReserve,
  resolveAsset,
  validateAddress,
  isMuxedAddress,
  getBaseAccountId,
  validateMemo,
  buildStellarMemo,
  redactMemo,
  fundTestnetAccount,
  getTransactionUrl,
};
