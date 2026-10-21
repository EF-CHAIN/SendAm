/**
 * Stellar Horizon & Soroban transaction result codes, operation codes,
 * and simulation failure remediation knowledge base.
 * Closes #755.
 */

export const STELLAR_ERROR_MAP = {
  // Transaction-level result codes
  tx_failed: {
    code: 'tx_failed',
    title: 'Transaction Failed',
    explanation: 'One or more operations in the transaction envelope failed during simulation or ledger execution.',
    remediation: 'Inspect the individual operation error codes below to identify the specific failure cause and take corrective action.',
    category: 'transaction',
  },
  tx_too_early: {
    code: 'tx_too_early',
    title: 'Transaction Submitted Too Early',
    explanation: 'The transaction envelope specifies a minimum valid timeBound (minTime) that has not yet elapsed.',
    remediation: 'Wait until the configured minTime timestamp passes before re-submitting, or adjust the timeBounds window.',
    category: 'transaction',
  },
  tx_too_late: {
    code: 'tx_too_late',
    title: 'Transaction Expired (Too Late)',
    explanation: 'The transaction envelope maxTime deadline has already expired before reaching ledger consensus.',
    remediation: 'Rebuild the transaction with a fresh timeBounds window and re-sign with all required account keys.',
    category: 'transaction',
  },
  tx_bad_seq: {
    code: 'tx_bad_seq',
    title: 'Invalid Sequence Number',
    explanation: 'The transaction sequence number does not match the source account sequence number currently on the ledger.',
    remediation: 'Fetch the latest source account state from Horizon or Soroban RPC and increment sequence by 1.',
    category: 'transaction',
  },
  tx_bad_auth: {
    code: 'tx_bad_auth',
    title: 'Insufficient or Invalid Signatures',
    explanation: 'Too few valid signatures were provided, or the signing keys do not meet the account threshold weights.',
    remediation: 'Ensure all required keys have signed the envelope and their total signature weight satisfies the transaction threshold.',
    category: 'transaction',
  },
  tx_insufficient_balance: {
    code: 'tx_insufficient_balance',
    title: 'Insufficient Fee Balance',
    explanation: 'The source account balance is too low to pay the base transaction network fee.',
    remediation: 'Fund the source account with additional XLM to satisfy base reserves plus transaction fees.',
    category: 'transaction',
  },
  tx_no_source_account: {
    code: 'tx_no_source_account',
    title: 'Source Account Not Found',
    explanation: 'The transaction source account does not exist on the Stellar ledger.',
    remediation: 'Fund the account using createAccount (with at least 1 XLM minimum balance) before submitting transactions from it.',
    category: 'transaction',
  },
  tx_insufficient_fee: {
    code: 'tx_insufficient_fee',
    title: 'Fee Below Network Minimum',
    explanation: 'The fee bid is lower than the network minimum fee rate during surge pricing.',
    remediation: 'Increase the max_fee bid in stroops to meet the current network ledger fee requirements.',
    category: 'transaction',
  },
  tx_bad_auth_extra: {
    code: 'tx_bad_auth_extra',
    title: 'Extraneous Signatures Attached',
    explanation: 'Unused or irrelevant signatures were attached to the transaction envelope.',
    remediation: 'Remove signatures that do not correspond to any signer on the source or operation accounts.',
    category: 'transaction',
  },
  tx_internal_error: {
    code: 'tx_internal_error',
    title: 'Horizon / Validator Internal Error',
    explanation: 'An internal node or validator error occurred while processing the transaction simulation.',
    remediation: 'Retry the simulation or submission against an alternative Horizon or Soroban RPC endpoint.',
    category: 'transaction',
  },

  // Operation-level error codes
  op_underfunded: {
    code: 'op_underfunded',
    title: 'Insufficient Account Balance',
    explanation: 'Source wallet does not have enough XLM reserve or asset balance to complete this payment.',
    remediation: 'Top up the source account with additional XLM or the required asset, or reduce the transfer amount. Check current subentry reserves (0.5 XLM per trustline/offer/signer).',
    category: 'operation',
  },
  op_no_trust: {
    code: 'op_no_trust',
    title: 'Missing Trustline',
    explanation: 'The destination account does not have a trustline established for the asset being transferred.',
    remediation: 'The recipient account must first submit a changeTrust operation for this asset and issuer before it can receive funds.',
    category: 'operation',
  },
  op_not_authorized: {
    code: 'op_not_authorized',
    title: 'Asset Holding Not Authorized',
    explanation: 'The asset issuer requires authorization (AUTH_REQUIRED_FLAG) and has not authorized this recipient account.',
    remediation: 'Contact the asset issuer to authorize the holding account, or verify the compliance flag status with the anchor.',
    category: 'operation',
  },
  op_line_full: {
    code: 'op_line_full',
    title: 'Trustline Limit Exceeded',
    explanation: 'Receiving this payment would cause the destination trustline balance to exceed its configured maximum limit.',
    remediation: 'The recipient must increase their trustline limit via a changeTrust operation, or the sender must reduce the payment amount.',
    category: 'operation',
  },
  op_no_destination: {
    code: 'op_no_destination',
    title: 'Destination Account Does Not Exist',
    explanation: 'The target destination public key has not been funded or created on the Stellar ledger.',
    remediation: 'If sending native XLM, use the createAccount operation instead of payment to fund and initialize the new account (minimum 1 XLM).',
    category: 'operation',
  },
  op_no_issuer: {
    code: 'op_no_issuer',
    title: 'Asset Issuer Account Does Not Exist',
    explanation: 'The asset issuer specified in the asset code/issuer pair does not exist on the network.',
    remediation: 'Verify the asset issuer public key. Ensure the issuer account is funded and active on the selected network.',
    category: 'operation',
  },
  op_low_reserve: {
    code: 'op_low_reserve',
    title: 'Balance Below Minimum Ledger Reserve',
    explanation: 'Executing this operation would drop the account balance below the network minimum reserve requirement.',
    remediation: 'Deposit additional XLM to cover base reserves (1 XLM base + 0.5 XLM per trustline/data/signer), or close unused entries.',
    category: 'operation',
  },
  op_already_exists: {
    code: 'op_already_exists',
    title: 'Account Already Exists',
    explanation: 'Attempted to run createAccount for a destination that is already an active ledger account.',
    remediation: 'Use a standard payment operation instead of createAccount to transfer funds to an existing account.',
    category: 'operation',
  },
  op_bad_auth: {
    code: 'op_bad_auth',
    title: 'Operation Signature Unauthorized',
    explanation: 'The key used to authorize this specific operation does not possess adequate signing weight.',
    remediation: 'Verify the operation source account signer configuration and threshold weights (low, medium, or high).',
    category: 'operation',
  },
  op_src_no_trust: {
    code: 'op_src_no_trust',
    title: 'Source Account Missing Trustline',
    explanation: 'The source account attempting to send or manage this asset does not hold a trustline for it.',
    remediation: 'Submit a changeTrust operation from the source account before attempting to transfer this asset.',
    category: 'operation',
  },
  op_src_not_authorized: {
    code: 'op_src_not_authorized',
    title: 'Source Account Revoked by Issuer',
    explanation: 'The source account authorization to transfer this asset was revoked by the asset issuer.',
    remediation: 'Reach out to the asset issuer or anchor to restore authorization for the source account.',
    category: 'operation',
  },
  op_cross_self: {
    code: 'op_cross_self',
    title: 'Trading Offer Crosses Self',
    explanation: 'The submitted trading order would execute against an existing offer created by the same account.',
    remediation: 'Cancel or adjust the existing order on the decentralized exchange before creating a new one.',
    category: 'operation',
  },
  op_over_sendmax: {
    code: 'op_over_sendmax',
    title: 'Path Payment Exceeded Send Max',
    explanation: 'No conversion path could fulfill the destination amount without exceeding the declared sendMax tolerance.',
    remediation: 'Increase the sendMax amount to allow for slippage, or verify market depth on the DEX orderbook.',
    category: 'operation',
  },
  op_no_path: {
    code: 'op_no_path',
    title: 'No Conversion Path Found',
    explanation: 'No liquid route or orderbook offers exist between the source asset and destination asset.',
    remediation: 'Verify liquidity pool and DEX order depth between the two currencies before executing path payments.',
    category: 'operation',
  },
  op_too_many_sponsoring: {
    code: 'op_too_many_sponsoring',
    title: 'Sponsorship Limit Exceeded',
    explanation: 'The sponsoring account has reached the maximum permitted number of sponsored subentries.',
    remediation: 'Revoke existing sponsorships before initiating new entry sponsorships.',
    category: 'operation',
  },
  host_function_error: {
    code: 'host_function_error',
    title: 'Soroban Smart Contract Execution Failed',
    explanation: 'The Soroban host function invocation reverted or failed due to contract precondition panic.',
    remediation: 'Check contract event logs, ensure all auth invocations are signed, and verify input parameters match contract spec.',
    category: 'soroban',
  },
};

/**
 * Normalizes an error code by removing underscores and case differences.
 */
function normalizeKey(str) {
  if (!str || typeof str !== 'string') return '';
  return str.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Looks up human-readable remediation for a Stellar error code.
 */
export function lookupStellarErrorCode(code) {
  if (!code) return null;
  const rawKey = String(code).trim();
  const normalized = normalizeKey(rawKey);

  // Exact match
  if (STELLAR_ERROR_MAP[rawKey]) return STELLAR_ERROR_MAP[rawKey];
  if (STELLAR_ERROR_MAP[normalized]) return STELLAR_ERROR_MAP[normalized];

  // Try camelCase to snake_case (e.g. opUnderfunded -> op_underfunded)
  const snake = rawKey
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_+/, '');
  if (STELLAR_ERROR_MAP[snake]) return STELLAR_ERROR_MAP[snake];

  // Search by code property
  const found = Object.values(STELLAR_ERROR_MAP).find(
    (item) => item.code === normalized || item.code === snake || item.code.replace(/_/g, '') === normalized.replace(/_/g, '')
  );
  if (found) return found;

  return {
    code: rawKey,
    title: `Error: ${rawKey}`,
    explanation: `Transaction simulation failed with error code "${rawKey}".`,
    remediation: 'Inspect transaction parameters, account balances, sequence numbers, and signing keys.',
    category: 'unknown',
  };
}

/**
 * Parses raw text, Horizon JSON, or decoded XDR results for Stellar simulation error codes.
 * Returns an array of decoded error items or null if no simulation errors are found.
 */
export function extractSimulationErrors(input, decodedResult = null) {
  const errorCodes = new Set();

  // 1. Check decoded XDR result for transaction and operation codes
  if (decodedResult) {
    if (decodedResult.resultCode && decodedResult.resultCode !== 'tx_success' && decodedResult.resultCode !== 'txSUCCESS') {
      errorCodes.add(decodedResult.resultCode);
    }
    if (decodedResult.operations && Array.isArray(decodedResult.operations)) {
      decodedResult.operations.forEach((op) => {
        if (op.resultCode && op.resultCode !== 'op_success' && op.resultCode !== 'opSUCCESS') {
          errorCodes.add(op.resultCode);
        }
      });
    }
  }

  // 2. Parse input string if provided
  if (input && typeof input === 'string') {
    const trimmed = input.trim();

    // Check if input is a JSON string (e.g. Horizon 400 error payload)
    try {
      const parsedJson = JSON.parse(trimmed);
      const extractFromJson = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (obj.result_codes) {
          if (obj.result_codes.transaction) errorCodes.add(obj.result_codes.transaction);
          if (Array.isArray(obj.result_codes.operations)) {
            obj.result_codes.operations.forEach((op) => errorCodes.add(op));
          }
        }
        if (obj.transactionResultCode) errorCodes.add(obj.transactionResultCode);
        if (obj.operationResultCodes && Array.isArray(obj.operationResultCodes)) {
          obj.operationResultCodes.forEach((op) => errorCodes.add(op));
        }
        if (obj.code && typeof obj.code === 'string') errorCodes.add(obj.code);
        if (obj.detail && typeof obj.detail === 'string') {
          findKnownCodesInText(obj.detail);
        }
      };

      extractFromJson(parsedJson);
      if (parsedJson.extras) extractFromJson(parsedJson.extras);
    } catch {
      // Not JSON, search plain text for known error codes
    }

    // Search plain text for known codes (e.g. op_underfunded, op_no_trust, tx_failed)
    findKnownCodesInText(trimmed);
  }

  function findKnownCodesInText(text) {
    const lower = text.toLowerCase();
    Object.keys(STELLAR_ERROR_MAP).forEach((key) => {
      // Look for whole-word or delimited occurrences of key
      const regex = new RegExp(`\\b${key}\\b`, 'i');
      if (regex.test(lower)) {
        errorCodes.add(key);
      }
    });

    // Also look for camelCase variants like opUnderfunded
    const camelVariants = [
      'opUnderfunded',
      'opNoTrust',
      'opNotAuthorized',
      'opLineFull',
      'opNoDestination',
      'opNoIssuer',
      'opLowReserve',
      'opAlreadyExists',
      'opBadAuth',
      'opSrcNoTrust',
      'txFailed',
      'txBadSeq',
      'txBadAuth',
    ];
    camelVariants.forEach((camel) => {
      if (text.includes(camel)) {
        errorCodes.add(camel);
      }
    });
  }

  // Filter out success codes
  errorCodes.delete('tx_success');
  errorCodes.delete('txSUCCESS');
  errorCodes.delete('op_success');
  errorCodes.delete('opSUCCESS');

  if (errorCodes.size === 0) return null;

  return Array.from(errorCodes).map(lookupStellarErrorCode);
}
