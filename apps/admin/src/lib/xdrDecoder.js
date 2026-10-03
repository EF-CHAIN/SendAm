import * as StellarSdk from '@stellar/stellar-sdk';

/**
 * Formats stroops into XLM.
 * 1 XLM = 10,000,000 stroops (10^7)
 */
export function stroopsToXlm(stroops) {
  if (stroops === undefined || stroops === null) return '0';
  const num = Number(stroops);
  if (isNaN(num)) return String(stroops);
  return (num / 10000000).toLocaleString(undefined, { maximumFractionDigits: 7 });
}

/**
 * Formats a Stellar asset object into a human-readable string.
 */
export function formatAsset(asset) {
  if (!asset) return 'Native (XLM)';
  if (typeof asset === 'string') return asset;
  if (asset.isNative && asset.isNative()) return 'Native (XLM)';
  if (asset.code) {
    return `${asset.code}${asset.issuer ? ` (${asset.issuer})` : ''}`;
  }
  if (asset.asset_code) {
    return `${asset.asset_code}${asset.asset_issuer ? ` (${asset.asset_issuer})` : ''}`;
  }
  return 'Unknown Asset';
}

/**
 * Normalizes and decodes an operation into a readable format.
 */
export function formatOperation(op, index) {
  const type = op.type || op._switch?.name || 'UnknownOperation';
  const details = { ...op };

  let summary;
  const attributes = [];

  switch (type) {
    case 'payment':
    case 'Payment':
      summary = `Payment: ${op.amount || 0} ${formatAsset(op.asset)} → ${op.destination || op.to}`;
      attributes.push({ label: 'Destination', value: op.destination || op.to });
      attributes.push({ label: 'Amount', value: `${op.amount || 0} ${formatAsset(op.asset)}` });
      break;

    case 'createAccount':
    case 'CreateAccount':
      summary = `Create Account: ${op.destination || op.to} with starting balance ${op.startingBalance || op.amount || 0} XLM`;
      attributes.push({ label: 'Destination', value: op.destination || op.to });
      attributes.push({ label: 'Starting Balance', value: `${op.startingBalance || op.amount || 0} XLM` });
      break;

    case 'changeTrust':
    case 'ChangeTrust': {
      const limit = op.limit !== undefined ? (op.limit === '' || op.limit === '922337203685.4775807' ? 'Max' : op.limit) : 'Max';
      summary = `Change Trust: ${formatAsset(op.line || op.asset)} (Limit: ${limit})`;
      attributes.push({ label: 'Asset', value: formatAsset(op.line || op.asset) });
      attributes.push({ label: 'Limit', value: limit });
      break;
    }

    case 'pathPaymentStrictReceive':
    case 'PathPaymentStrictReceive':
      summary = `Path Payment (Strict Receive): max ${op.sendMax} ${formatAsset(op.sendAsset)} → ${op.destAmount} ${formatAsset(op.destAsset)} to ${op.destination}`;
      attributes.push({ label: 'Destination', value: op.destination });
      attributes.push({ label: 'Dest Amount', value: `${op.destAmount} ${formatAsset(op.destAsset)}` });
      attributes.push({ label: 'Send Max', value: `${op.sendMax} ${formatAsset(op.sendAsset)}` });
      break;

    case 'pathPaymentStrictSend':
    case 'PathPaymentStrictSend':
      summary = `Path Payment (Strict Send): ${op.sendAmount} ${formatAsset(op.sendAsset)} → min ${op.destMin} ${formatAsset(op.destAsset)} to ${op.destination}`;
      attributes.push({ label: 'Destination', value: op.destination });
      attributes.push({ label: 'Send Amount', value: `${op.sendAmount} ${formatAsset(op.sendAsset)}` });
      attributes.push({ label: 'Dest Min', value: `${op.destMin} ${formatAsset(op.destAsset)}` });
      break;

    case 'accountMerge':
    case 'AccountMerge':
      summary = `Account Merge → ${op.destination || op.into}`;
      attributes.push({ label: 'Destination', value: op.destination || op.into });
      break;

    case 'setOptions':
    case 'SetOptions':
      summary = `Set Options: Master Weight: ${op.masterWeight ?? '—'}, Low: ${op.lowThreshold ?? '—'}, Med: ${op.medThreshold ?? '—'}, High: ${op.highThreshold ?? '—'}`;
      if (op.signer) attributes.push({ label: 'Signer', value: `${op.signer.key || op.signer.ed25519PublicKey} (Weight: ${op.signer.weight})` });
      if (op.homeDomain) attributes.push({ label: 'Home Domain', value: op.homeDomain });
      break;

    case 'manageData':
    case 'ManageData':
      summary = `Manage Data: Key "${op.name || op.dataName}" = "${op.value ? op.value.toString() : '<deleted>'}"`;
      attributes.push({ label: 'Key', value: op.name || op.dataName });
      attributes.push({ label: 'Value', value: op.value ? op.value.toString() : '<deleted>' });
      break;

    case 'invokeHostFunction':
    case 'InvokeHostFunction':
      summary = `Soroban Smart Contract: Invoke Host Function`;
      if (op.functionName) attributes.push({ label: 'Function', value: op.functionName });
      break;

    default:
      summary = `${type} operation`;
      break;
  }

  if (op.source) {
    attributes.unshift({ label: 'Source Account', value: op.source });
  }

  return {
    index: index + 1,
    type,
    summary,
    sourceAccount: op.source || null,
    attributes,
    raw: details,
  };
}

/**
 * Decodes a raw base64 or hex Stellar XDR string.
 * Supports TransactionEnvelope, FeeBumpTransaction, TransactionResult.
 *
 * @param {string} rawXdr - Base64 or Hex encoded XDR string
 * @param {string} networkPassphrase - Stellar Network Passphrase (default: Public or Testnet)
 * @returns {object} Decoded transaction envelope information
 */
export function decodeStellarXdr(rawXdr, networkPassphrase = StellarSdk.Networks.PUBLIC) {
  if (!rawXdr || typeof rawXdr !== 'string' || !rawXdr.trim()) {
    throw new Error('XDR string cannot be empty');
  }

  const cleanedXdr = rawXdr.trim();

  // Try parsing as standard Transaction or FeeBumpTransaction
  try {
    const tx = StellarSdk.TransactionBuilder.fromXDR(cleanedXdr, networkPassphrase);
    const isFeeBump = !!tx.innerTransaction;

    const baseTx = isFeeBump ? tx.innerTransaction : tx;
    const memoType = baseTx.memo ? (typeof baseTx.memo.type === 'string' ? baseTx.memo.type : 'none') : 'none';
    const memoValue = baseTx.memo && baseTx.memo.value !== undefined ? String(baseTx.memo.value) : '';

    const timeBounds = baseTx.timeBounds
      ? {
          minTime: baseTx.timeBounds.minTime ? new Date(Number(baseTx.timeBounds.minTime) * 1000).toISOString() : '0',
          maxTime: baseTx.timeBounds.maxTime && baseTx.timeBounds.maxTime !== '0' ? new Date(Number(baseTx.timeBounds.maxTime) * 1000).toISOString() : 'None (Open)',
          raw: baseTx.timeBounds,
        }
      : null;

    const operations = (baseTx.operations || []).map((op, idx) => formatOperation(op, idx));

    const signatures = (tx.signatures || []).map((sig, idx) => {
      const hint = sig.hint ? sig.hint().toString('hex') : (sig.hintHex || '—');
      const signature = sig.signature ? sig.signature().toString('base64') : (sig.signatureBase64 || '—');
      return {
        index: idx + 1,
        hint,
        signature,
      };
    });

    const feeStroops = isFeeBump ? tx.fee : baseTx.fee;
    const feeXlm = stroopsToXlm(feeStroops);

    return {
      success: true,
      envelopeType: isFeeBump ? 'FeeBumpTransactionEnvelope' : 'TransactionEnvelope',
      isFeeBump,
      sourceAccount: baseTx.source,
      feeSource: isFeeBump ? tx.feeSource : baseTx.source,
      sequence: baseTx.sequence ? String(baseTx.sequence) : '—',
      fee: {
        stroops: String(feeStroops),
        xlm: feeXlm,
      },
      memo: {
        type: memoType,
        value: memoValue,
      },
      timeBounds,
      operationCount: operations.length,
      operations,
      signatures,
      networkPassphrase,
      rawJson: {
        type: isFeeBump ? 'FeeBumpTransaction' : 'Transaction',
        source: baseTx.source,
        fee: feeStroops,
        sequence: baseTx.sequence,
        operations: baseTx.operations,
        signatures: signatures,
      },
    };
  } catch (txErr) {
    // If TransactionBuilder.fromXDR fails, attempt direct low-level XDR envelope or result parsing
    try {
      const envelope = StellarSdk.xdr.TransactionEnvelope.fromXDR(cleanedXdr, 'base64');
      const envelopeType = envelope.arm() || 'TransactionEnvelope';

      return {
        success: true,
        envelopeType,
        isFeeBump: envelopeType.toLowerCase().includes('feebump'),
        sourceAccount: 'N/A (Low-level envelope)',
        sequence: '—',
        fee: { stroops: '—', xlm: '—' },
        memo: { type: 'none', value: '' },
        timeBounds: null,
        operationCount: 0,
        operations: [],
        signatures: [],
        networkPassphrase,
        rawJson: envelope.toJSON ? envelope.toJSON() : envelope,
      };
    } catch {
      // Attempt TransactionResult parsing
      try {
        const result = StellarSdk.xdr.TransactionResult.fromXDR(cleanedXdr, 'base64');
        return {
          success: true,
          envelopeType: 'TransactionResult',
          isFeeBump: false,
          sourceAccount: 'N/A (Result)',
          sequence: '—',
          fee: { stroops: result.feeCharged ? String(result.feeCharged().toString()) : '0', xlm: stroopsToXlm(result.feeCharged ? result.feeCharged().toString() : 0) },
          memo: { type: 'none', value: '' },
          timeBounds: null,
          operationCount: 0,
          operations: [],
          signatures: [],
          networkPassphrase,
          resultCode: result.result()?.switch()?.name || 'tx_result',
          rawJson: result.toJSON ? result.toJSON() : result,
        };
      } catch {
        throw new Error(`Failed to decode Stellar XDR: ${txErr.message || 'Malformed base64/hex data'}`);
      }
    }
  }
}
