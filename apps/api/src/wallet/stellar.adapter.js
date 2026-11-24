// Stellar wallet adapter — keypair creation, Friendbot funding, balance,
// and payment submission. The only chain SDK integration in the codebase.
const { server, StellarSdk } = require("../config/stellar");
const { isHorizonWriteUncertain } = require("../config/horizon");
const axios = require("axios");
const logger = require("../utils/logger");
const config = require("../config/env");
const { assertValidAmount, formatUnits, parseUnits } = require("../utils/money");
const { outboundHeaders } = require("../observability/context");
const assetIdentity = require("./assetIdentity");
const { nativeBalance, PRECISION } = require("./balanceCalculator");
const { routePathPayment, pathAmount } = require("../payment/pathPaymentRouter");

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

const BASE_RESERVE_XLM = 1;
const BASE_RESERVE_PER_ENTRY = 0.5;
const FUNDING_MAX_ATTEMPTS = 3;
const fetchBaseReserve = async () => {
  if (process.env.STELLAR_BASE_RESERVE_XLM) {
    return parseUnits(process.env.STELLAR_BASE_RESERVE_XLM, PRECISION);
  }
  const { records: [ledger] } = await server.ledgers().order("desc").limit(1).call();
  const reserve = BigInt(ledger.base_reserve_in_stroops);
  if (reserve <= 0n) throw new Error("Invalid Stellar base reserve.");
  return reserve;
};

function assertNativeReserve(account, feeStroops, additionalSubentries = 0, baseReserveStroops = 5_000_000n, amount) {
  const balance = nativeBalance(account, {
    feeStroops, baseReserveStroops, additionalSubentries,
    buffer: additionalSubentries ? process.env.STELLAR_RESERVE_BUFFER_XLM || "0.1" : "0",
  });
  if (balance.available < 0n) {
    throw Object.assign(new Error(
      `Insufficient XLM reserve. Keep at least ${formatUnits(balance.required, PRECISION)} XLM for account reserve and fees, then retry.`,
    ), { code: "insufficient_reserve" });
  }
  if (amount && parseUnits(amount, PRECISION) > balance.available) {
    throw Object.assign(new Error(`Insufficient spendable balance. You can send up to ${balance.spendable} XLM.`), { statusCode: 409 });
  }
  return balance;
}

const getSeverityPriority = (status) => ({ ok: 0, warning: 1, critical: 2 }[status] || 0);

const getHighWaterMarkStatus = (value, warningThreshold, criticalThreshold) => {
  if (criticalThreshold != null && value >= criticalThreshold) return 'critical';
  if (warningThreshold != null && value >= warningThreshold) return 'warning';
  return 'ok';
};

const getLowWaterMarkStatus = (value, warningThreshold, criticalThreshold) => {
  if (criticalThreshold != null && value <= criticalThreshold) return 'critical';
  if (warningThreshold != null && value <= warningThreshold) return 'warning';
  return 'ok';
};

const getReservePressureStatus = (ratio, warningThreshold, criticalThreshold) => {
  if (criticalThreshold != null && ratio >= criticalThreshold) return 'critical';
  if (warningThreshold != null && ratio >= warningThreshold) return 'warning';
  return 'ok';
};

const getOperatorRunbook = ({ baseFeeStatus, fundingBalanceStatus, reserveStatus, baseFee, fundingBalance, projectedReserveRatio }) => {
  const steps = [];

  if (baseFeeStatus !== 'ok') {
    steps.push(`Base fee is ${baseFee} stroops; raise the funding account or slow outbound payments until network demand settles.`);
  }

  if (fundingBalanceStatus !== 'ok') {
    steps.push(`Funding account balance is ${fundingBalance} XLM; add XLM so customer wallet creation and sends keep a safe buffer.`);
  }

  if (reserveStatus !== 'ok') {
    steps.push(`Projected reserve consumption is ${(projectedReserveRatio * 100).toFixed(1)}% of funding balance; reduce new trustlines or pause wallet creation until reserve headroom returns.`);
  }

  if (steps.length === 0) {
    return ['Funding account is healthy; continue normal wallet creation and payment flow.'];
  }

  return steps;
};

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

const getFundingAccountHealth = async ({
  publicKey,
  reserveEntries = 0,
  baseFeeWarningThreshold,
  baseFeeCriticalThreshold,
  fundingBalanceWarningThreshold,
  fundingBalanceCriticalThreshold,
  reserveWarningThreshold,
  reserveCriticalThreshold,
} = {}) => {
  const targetPublicKey = publicKey || config.stellar.fundingAccountPublicKey;
  if (!targetPublicKey) {
    throw new Error('Stellar funding account public key is not configured.');
  }

  const thresholds = {
    baseFeeWarningThreshold: baseFeeWarningThreshold ?? config.stellar.thresholds.baseFeeWarningThreshold,
    baseFeeCriticalThreshold: baseFeeCriticalThreshold ?? config.stellar.thresholds.baseFeeCriticalThreshold,
    fundingBalanceWarningThreshold: fundingBalanceWarningThreshold ?? config.stellar.thresholds.fundingBalanceWarningThreshold,
    fundingBalanceCriticalThreshold: fundingBalanceCriticalThreshold ?? config.stellar.thresholds.fundingBalanceCriticalThreshold,
    reserveWarningThreshold: reserveWarningThreshold ?? config.stellar.thresholds.reserveWarningThreshold,
    reserveCriticalThreshold: reserveCriticalThreshold ?? config.stellar.thresholds.reserveCriticalThreshold,
  };

  const account = await server.loadAccount(targetPublicKey);
  const nativeBalance = account.balances.find((b) => b.asset_type === 'native');
  const fundingBalance = Number(nativeBalance ? nativeBalance.balance : '0');
  const subentryCount = Number(account.subentry_count || 0);
  const currentReserveRequired = BASE_RESERVE_XLM + subentryCount * BASE_RESERVE_PER_ENTRY;
  const projectedReserveRequired = BASE_RESERVE_XLM + (subentryCount + Number(reserveEntries)) * BASE_RESERVE_PER_ENTRY;
  const currentReserveRatio = currentReserveRequired / Math.max(fundingBalance, Number.EPSILON);
  const projectedReserveRatio = projectedReserveRequired / Math.max(fundingBalance, Number.EPSILON);
  const baseFee = Number(await server.fetchBaseFee());

  const baseFeeStatus = getHighWaterMarkStatus(
    baseFee,
    thresholds.baseFeeWarningThreshold,
    thresholds.baseFeeCriticalThreshold,
  );
  const fundingBalanceStatus = getLowWaterMarkStatus(
    fundingBalance,
    thresholds.fundingBalanceWarningThreshold,
    thresholds.fundingBalanceCriticalThreshold,
  );
  const reserveStatus = getReservePressureStatus(
    Math.max(currentReserveRatio, projectedReserveRatio),
    thresholds.reserveWarningThreshold,
    thresholds.reserveCriticalThreshold,
  );

  const status = [baseFeeStatus, fundingBalanceStatus, reserveStatus]
    .reduce((highest, entry) => (
      getSeverityPriority(entry) > getSeverityPriority(highest) ? entry : highest
    ), 'ok');

  const report = {
    status,
    publicKey: targetPublicKey,
    baseFee,
    baseFeeStatus,
    fundingBalance,
    fundingBalanceStatus,
    reserveRequired: Number(currentReserveRequired.toFixed(7)),
    projectedReserveRequired: Number(projectedReserveRequired.toFixed(7)),
    currentReserveRatio: Number(currentReserveRatio.toFixed(4)),
    projectedReserveRatio: Number(projectedReserveRatio.toFixed(4)),
    reserveStatus,
    fundingCapacityWallets: Math.max(0, Math.floor(fundingBalance / Math.max(1 + Number(reserveEntries) * BASE_RESERVE_PER_ENTRY, Number.EPSILON))),
    runbook: getOperatorRunbook({
      baseFeeStatus,
      fundingBalanceStatus,
      reserveStatus,
      baseFee,
      fundingBalance,
      projectedReserveRatio,
    }),
  };

  if (status !== 'ok') {
    logger.warn(
      `Stellar funding-account health warning: ${status} for ${targetPublicKey}; baseFee=${baseFee} stroops, balance=${fundingBalance} XLM, projectedReserveUsage=${(projectedReserveRatio * 100).toFixed(1)}%.`,
    );
  }

  return report;
};

// Every balance line for a wallet, each tagged with its canonical asset
// identity (network + code + issuer) and whether this service recognises the
// issuer. Horizon lists every trustline regardless of issuer — a same-code
// trustline from another issuer (e.g. someone else's "USDC") is a different,
// unrelated asset. It is still returned here (never dropped, so reconciliation
// evidence isn't lost) but marked `trusted: false`; callers must never treat
// an untrusted row as the real asset just because the code matches (#285).
const getBalances = async (publicKey) => {
  try {
    const [account, feeStroops, baseReserveStroops] = await Promise.all([
      server.loadAccount(publicKey), server.fetchBaseFee(), fetchBaseReserve(),
    ]);
    const network = config.stellar.network;
    const balances = [];

    const xlmBalance = account.balances.find((b) => b.asset_type === "native");
    const nativeIdentity = assetIdentity.describeAsset({ network, assetType: "native" });
    balances.push({
      asset: "XLM",
      value: xlmBalance ? xlmBalance.balance : "0",
      spendable: nativeBalance(account, { feeStroops, baseReserveStroops }).spendable,
      issuer: nativeIdentity.issuer,
      network: nativeIdentity.network,
      assetId: nativeIdentity.assetId,
      trusted: nativeIdentity.trusted,
    });

    account.balances
      .filter((b) => b.asset_type !== "native")
      .forEach((b) => {
        const identity = assetIdentity.describeAsset({
          network,
          assetType: b.asset_type,
          code: b.asset_code,
          issuer: b.asset_issuer,
        });
        balances.push({
          asset: identity.code,
          value: b.balance,
          issuer: identity.issuer,
          network: identity.network,
          assetId: identity.assetId,
          trusted: identity.trusted,
        });
      });

    return balances;
  } catch (error) {
    logger.error("Error getting balances", error.message);
    throw new Error("Could not fetch balances. Check if account is funded.");
  }
};

const resolveAsset = (asset, { path = false } = {}) => {
  if (!asset || asset === "XLM" || asset === "native") return StellarSdk.Asset.native();
  const issuer = assetIdentity.resolveConfiguredIssuer({ network: config.stellar.network, code: asset });
  if (issuer && (asset === "USDC" || path)) return new StellarSdk.Asset(asset, issuer);
  throw Object.assign(new Error(`Unsupported asset on Stellar: ${asset}.`), {
    code: 'unsupported_asset',
    retryable: false,
  });
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

const classifyRecoverableError = (error) => {
  const message = String(error?.message || error || '').toLowerCase();
  const codes = error?.response?.data?.extras?.result_codes;

  if (codes?.operations?.includes("op_no_trust")) {
    return { code: 'missing_trustline', retryable: false, userMessage: 'Missing trustline — the recipient needs to open a trustline for this asset.', action: 'open_trustline' };
  }

  if (codes?.operations?.includes("op_underfunded")) {
    return { code: 'underfunded', retryable: false, userMessage: 'Insufficient balance — the sender needs more XLM.', action: 'fund_account' };
  }

  if (codes?.operations?.includes("op_line_full")) {
    return { code: 'line_full', retryable: false, userMessage: 'Trustline limit reached — remove an unused trustline.', action: 'remove_trustline' };
  }

  if (codes?.operations?.includes("op_src_no_trust")) {
    return { code: 'source_no_trust', retryable: false, userMessage: 'Sender has no trustline for this asset.', action: 'open_trustline' };
  }

  if (codes?.operations?.includes("op_src_no_authorization")) {
    return { code: 'source_not_authorized', retryable: false, userMessage: 'Sender trustline is not authorized.', action: 'contact_support' };
  }

  if (/not funded yet/.test(message) || /account is not funded/.test(message)) {
    return { code: 'account_not_funded', retryable: true, userMessage: 'Account is not funded yet.', action: 'fund_account' };
  }

  if (/insufficient xlm reserve/.test(message)) {
    return { code: 'insufficient_reserve', retryable: false, userMessage: 'Not enough XLM to cover the account reserve and fees.', action: 'add_xlm' };
  }

  if (/unsupported asset/.test(message)) {
    return { code: 'unsupported_asset', retryable: false, userMessage: 'This asset is not supported.', action: 'none' };
  }

  if (/tx_bad_seq/.test(message) || codes?.transaction === 'tx_bad_seq') {
    return { code: 'bad_sequence', retryable: true, userMessage: 'Sequence number conflict — retrying with fresh sequence.', action: 'retry' };
  }

  return { code: 'unknown', retryable: false, userMessage: 'An unexpected error occurred.', action: 'contact_support' };
};

const classifyTrustlineError = (error) => {
  const message = String(error?.message || error || '').toLowerCase();

  if (/account is not funded/.test(message)) {
    return { code: 'account_not_funded', retryable: true, userMessage: 'Account is not funded yet — fund it before opening a trustline.' };
  }

  if (/insufficient xlm reserve/.test(message)) {
    return { code: 'insufficient_reserve', retryable: false, userMessage: 'Not enough XLM to cover the trustline reserve entry.' };
  }

  if (/change_trust/.test(message) && /already exists/.test(message)) {
    return { code: 'already_exists', retryable: false, userMessage: 'Trustline already exists.', alreadyExisted: true };
  }

  if (/op_no_trust/.test(message) || /op_src_no_trust/.test(message)) {
    return { code: 'missing_trustline', retryable: false, userMessage: 'Missing trustline for the requested asset.' };
  }

  return { code: 'unknown', retryable: false, userMessage: 'Could not establish trustline. Please retry.' };
};

// Concurrency coordination: serialize submissions per source account to eliminate sequence collisions.
const accountSubmissionLocks = new Map();

const withAccountLock = async (accountKey, fn) => {
  if (!accountKey) return fn();

  const currentLock = accountSubmissionLocks.get(accountKey) || Promise.resolve();
  let releaseLock;
  const nextLock = new Promise((resolve) => {
    releaseLock = resolve;
  });

  accountSubmissionLocks.set(
    accountKey,
    currentLock.then(() => nextLock, () => nextLock),
  );

  try {
    await currentLock;
    return await fn();
  } finally {
    releaseLock();
    if (accountSubmissionLocks.get(accountKey) === nextLock) {
      accountSubmissionLocks.delete(accountKey);
    }
  }
};

const resolveSigningStrategy = ({ secretKey, signer }) => {
  if (signer && typeof signer.signTransaction === 'function') {
    if (!signer.publicKey || !StellarSdk.StrKey.isValidEd25519PublicKey(signer.publicKey)) {
      throw new Error('Remote signer must provide a valid Stellar Ed25519 publicKey.');
    }
    return {
      sourcePublicKey: signer.publicKey,
      sign: async (transaction) => signer.signTransaction(transaction),
    };
  }
  if (!secretKey) {
    throw new Error('Either secretKey or a remote signer is required to sign Stellar transactions.');
  }
  const sourceKeypair = StellarSdk.Keypair.fromSecret(secretKey);
  return {
    sourcePublicKey: sourceKeypair.publicKey(),
    sign: async (transaction) => {
      transaction.sign(sourceKeypair);
      return transaction;
    },
  };
};

const submitPayment = async ({
  secretKey,
  signer,
  destination,
  amount,
  asset = "XLM",
  memo,
  memoType,
  pathPayment,
  onEnvelope,
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
    const sourceAsset = resolveAsset(asset, { path: Boolean(pathPayment) });
    const targetAsset = pathPayment && resolveAsset(pathPayment.destinationAsset, { path: true });
    const { sourcePublicKey, sign } = resolveSigningStrategy({ secretKey, signer });

    return await withAccountLock(sourcePublicKey, async () => {
      const baseDestination = getBaseAccountId(destination);

      // Check if destination exists (once; this doesn't change between retries).
      try {
        await server.loadAccount(baseDestination);
      } catch (_e) {
        throw new Error("Destination account does not exist or is not funded.");
      }

      const [fee, baseReserve] = await Promise.all([server.fetchBaseFee(), fetchBaseReserve()]);
      const networkPassphrase =
        config.stellar.network === "testnet"
          ? StellarSdk.Networks.TESTNET
          : StellarSdk.Networks.PUBLIC;

      const stellarMemo = buildStellarMemo({ memo, memoType });

      let transaction;
      let hash;
      let lastError;
      let uncertain = false;
      for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt += 1) {
        if (!transaction) {
          const sourceAccount = await server.loadAccount(sourcePublicKey);
          const balance = assertNativeReserve(sourceAccount, fee, 0, baseReserve,
            sourceAsset.isNative() && !pathPayment ? normalizedAmount : undefined);
          let operation;
          if (pathPayment) {
            let budget = pathAmount(normalizedAmount);
            if (sourceAsset.isNative()) {
              budget = balance.available < budget ? balance.available : budget;
            } else if (sourceAsset.getIssuer() !== sourcePublicKey) {
              const line = sourceAccount.balances.find((entry) =>
                entry.asset_code === sourceAsset.getCode() && entry.asset_issuer === sourceAsset.getIssuer());
              const available = parseUnits(line?.balance ?? "0", PRECISION)
                - parseUnits(line?.selling_liabilities ?? "0", PRECISION);
              if (line?.is_authorized === false || available <= 0n) budget = 0n;
              else if (available < budget) budget = available;
            }
            if (budget <= 0n) throw Object.assign(new Error("Insufficient spendable balance for a Stellar path payment."), { statusCode: 409 });
            operation = await routePathPayment({
              server,
              source: sourceAsset,
              target: targetAsset,
              maxSource: formatUnits(budget, PRECISION),
              destination,
              destinationAmount: pathPayment.destinationAmount,
            });
          } else {
            operation = StellarSdk.Operation.payment({ destination, asset: sourceAsset, amount: normalizedAmount });
          }

          const builder = new StellarSdk.TransactionBuilder(sourceAccount, { fee, networkPassphrase }).addOperation(operation);
          if (stellarMemo) builder.addMemo(stellarMemo);
          transaction = builder.setTimeout(30).build();
          await sign(transaction);
          hash = safeHash(transaction);
          if (onEnvelope) await onEnvelope(hash);
        }

        try {
          const txResponse = await server.submitTransaction(transaction);
          return {
            ledgerConfirmed: txResponse.successful === true && Boolean(txResponse.ledger),
            txHash: txResponse.hash,
            explorerUrl: getTransactionUrl(txResponse.hash),
          };
        } catch (error) {
          // Reconcile uncertain submissions before rebuilding or failing
          if (isHorizonWriteUncertain(error)) {
            uncertain = true;
            if (hash) {
              try {
                const found = await server.transactions().transactionHash(hash).call();
                if (found) {
                  logger.info(`Recovered seemingly-timed-out payment ${hash} via Horizon lookup.`);
                  return {
                    txHash: hash,
                    explorerUrl: getTransactionUrl(hash),
                    ledgerConfirmed: found.successful === true && Boolean(found.ledger),
                  };
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
              if (onEnvelope) return { txHash: hash, explorerUrl: getTransactionUrl(hash) };
              throw new Error("Transaction submission status unknown after timeout; not resubmitting to avoid a duplicate.");
            }
          }

          if (isBadSequence(error)) {
            if (hash) {
              try {
                const found = await server.transactions().transactionHash(hash).call();
                if (found) {
                  logger.info(`Recovered tx_bad_seq payment ${hash} via Horizon lookup.`);
                  return {
                    txHash: hash,
                    explorerUrl: getTransactionUrl(hash),
                    ledgerConfirmed: found.successful === true && Boolean(found.ledger),
                  };
                }
              } catch (_) {
                // lookup failed; fall through to the standard retry path
              }
            }

            if (uncertain && onEnvelope) return { txHash: hash, explorerUrl: getTransactionUrl(hash) };
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

          if (uncertain && onEnvelope) return { txHash: hash, explorerUrl: getTransactionUrl(hash) };
          const friendlyMessage = getFriendlyPaymentError(error);
          if (friendlyMessage) {
            throw new Error(friendlyMessage);
          }

          throw error;
        }
      }

      throw lastError || new Error("Failed to send payment");
    });
  } catch (error) {
    logger.error("Error sending payment", error.message);
    throw error;
  }
};

// Open a trustline so the wallet can hold an issued asset (e.g. USDC). This is
// a `changeTrust` operation the wallet signs for itself, and it costs one XLM
// reserve entry (see docs/STELLAR.md). Idempotent: callers may retry freely, so
// if the trustline already exists we report that without submitting anything.
const establishTrustline = async ({ secretKey, signer, assetCode }) => {
  const { sourcePublicKey, sign } = resolveSigningStrategy({ secretKey, signer });

  return withAccountLock(sourcePublicKey, async () => {
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

    const [fee, baseReserve] = await Promise.all([server.fetchBaseFee(), fetchBaseReserve()]);
    assertNativeReserve(account, fee, 1, baseReserve);
    const networkPassphrase =
      config.stellar.network === "testnet"
        ? StellarSdk.Networks.TESTNET
        : StellarSdk.Networks.PUBLIC;

    let lastError;
    for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt += 1) {
      const sourceAccount = await server.loadAccount(sourcePublicKey);
      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee,
        networkPassphrase,
      })
        .addOperation(StellarSdk.Operation.changeTrust({ asset }))
        .setTimeout(30)
        .build();

      await sign(transaction);
      const hash = safeHash(transaction);

      try {
        const txResponse = await server.submitTransaction(transaction);
        return {
          established: true,
          alreadyExisted: false,
          txHash: txResponse.hash,
          explorerUrl: getTransactionUrl(txResponse.hash),
        };
      } catch (error) {
        if (isHorizonWriteUncertain(error)) {
          if (hash) {
            try {
              const found = await server.transactions().transactionHash(hash).call();
              if (found) {
                return {
                  established: true,
                  alreadyExisted: false,
                  txHash: hash,
                  explorerUrl: getTransactionUrl(hash),
                };
              }
            } catch (_) {
              // lookup failed; resubmit the same envelope below
            }
          }
          if (attempt < SEND_MAX_ATTEMPTS) {
            await sleep(attempt * 250);
            continue;
          }
        }

        if (isBadSequence(error)) {
          if (hash) {
            try {
              const found = await server.transactions().transactionHash(hash).call();
              if (found) {
                return {
                  established: true,
                  alreadyExisted: false,
                  txHash: hash,
                  explorerUrl: getTransactionUrl(hash),
                };
              }
            } catch (_) {
              // lookup failed; treat as bad sequence and retry below
            }
          }
          if (attempt < SEND_MAX_ATTEMPTS) {
            lastError = error;
            await sleep(attempt * 250);
            continue;
          }
        }

        logger.error("Error establishing trustline", error.message);
        const classification = classifyTrustlineError(error);
        throw Object.assign(new Error(classification.userMessage), {
          code: classification.code,
          retryable: classification.retryable,
          alreadyExisted: classification.alreadyExisted || false,
          raw: error,
        });
      }
    }

    throw lastError || new Error(`Could not establish ${asset.getCode()} trustline.`);
  });
};

module.exports = {
  chain,
  createWallet,
  getBalance,
  getBalances,
  getFundingAccountHealth,
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
  classifyRecoverableError,
  classifyTrustlineError,
  getFriendlyPaymentError,
  withAccountLock,
};
