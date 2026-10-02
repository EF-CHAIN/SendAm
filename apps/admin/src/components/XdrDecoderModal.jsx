import { useState, useMemo, useEffect } from 'react';
import {
  X,
  Copy,
  Check,
  Search,
  Key,
  Shield,
  Clock,
  Layers,
  FileCode,
  AlertCircle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import * as StellarSdk from '@stellar/stellar-sdk';
import { decodeStellarXdr } from '@/lib/xdrDecoder';

/**
 * Copy to clipboard button with temporary feedback.
 */
function CopyButton({ text, label = 'Copy', className = '' }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e) => {
    e.stopPropagation();
    if (!text) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for non-secure contexts
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard write failure
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={`${label} to clipboard`}
      title={copied ? 'Copied!' : label}
      className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded transition-colors ${
        copied
          ? 'bg-green-100 text-green-700 border border-green-200'
          : 'bg-gray-100 text-gray-600 hover:bg-gray-200 border border-gray-200'
      } ${className}`}
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
      <span>{copied ? 'Copied' : label}</span>
    </button>
  );
}

/**
 * Client-side Stellar Horizon XDR Transaction Envelope Decoder and Visualizer Modal.
 * Closes #585.
 */
export default function XdrDecoderModal({
  isOpen,
  onClose,
  initialXdr = '',
  txHash = '',
}) {
  const [rawXdr, setRawXdr] = useState(initialXdr);
  const [network, setNetwork] = useState(StellarSdk.Networks.PUBLIC);
  const [customNetwork, setCustomNetwork] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('operations'); // 'operations' | 'raw' | 'signatures'
  const [expandedOps, setExpandedOps] = useState({});

  useEffect(() => {
    if (initialXdr) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sync editable XDR when a new initialXdr prop arrives
      setRawXdr(initialXdr);
    }
  }, [initialXdr]);

  // Decode XDR whenever rawXdr or network changes
  const { decoded, error } = useMemo(() => {
    if (!rawXdr || !rawXdr.trim()) {
      return { decoded: null, error: null };
    }
    try {
      const activeNetwork = network === 'CUSTOM' ? customNetwork : network;
      const result = decodeStellarXdr(rawXdr.trim(), activeNetwork);
      return { decoded: result, error: null };
    } catch (err) {
      return { decoded: null, error: err.message || 'Invalid or malformed Stellar XDR envelope' };
    }
  }, [rawXdr, network, customNetwork]);

  // Filter operations based on searchQuery
  const filteredOperations = useMemo(() => {
    if (!decoded || !decoded.operations) return [];
    if (!searchQuery.trim()) return decoded.operations;

    const q = searchQuery.toLowerCase().trim();
    return decoded.operations.filter((op) => {
      if (op.type.toLowerCase().includes(q)) return true;
      if (op.summary.toLowerCase().includes(q)) return true;
      if (op.sourceAccount && op.sourceAccount.toLowerCase().includes(q)) return true;
      return op.attributes?.some(
        (attr) =>
          attr.label.toLowerCase().includes(q) ||
          String(attr.value).toLowerCase().includes(q)
      );
    });
  }, [decoded, searchQuery]);

  const toggleOp = (idx) => {
    setExpandedOps((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="xdr-decoder-title"
    >
      <div className="bg-white rounded-2xl shadow-2xl border border-gray-200 w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in duration-200">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 bg-gray-50/80">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-50 text-indigo-600 rounded-lg">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <h2 id="xdr-decoder-title" className="text-lg font-bold text-gray-900">
                Stellar XDR Transaction Decoder
              </h2>
              <p className="text-xs text-gray-500">
                Client-side breakdown of Horizon transaction envelopes, operations, and signatures
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Input & Network Configuration */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="xdr-input" className="text-sm font-semibold text-gray-700">
                Base64 / Hex XDR String
              </label>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-gray-500">Network:</span>
                <select
                  value={network}
                  onChange={(e) => setNetwork(e.target.value)}
                  className="bg-white border border-gray-300 rounded-lg px-2.5 py-1 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  aria-label="Stellar Network Passphrase"
                >
                  <option value={StellarSdk.Networks.PUBLIC}>Public Network</option>
                  <option value={StellarSdk.Networks.TESTNET}>Testnet</option>
                  <option value={StellarSdk.Networks.FUTURENET}>Futurenet</option>
                  <option value="CUSTOM">Custom Passphrase</option>
                </select>
              </div>
            </div>

            {network === 'CUSTOM' && (
              <input
                type="text"
                value={customNetwork}
                onChange={(e) => setCustomNetwork(e.target.value)}
                placeholder="Enter custom network passphrase..."
                className="w-full text-xs font-mono p-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                aria-label="Custom Network Passphrase Input"
              />
            )}

            <div className="relative">
              <textarea
                id="xdr-input"
                rows={3}
                value={rawXdr}
                onChange={(e) => setRawXdr(e.target.value)}
                placeholder="Paste base64 or hex Stellar transaction envelope XDR here (e.g. AAAA...)..."
                className="w-full text-xs font-mono p-3 bg-gray-50 border border-gray-300 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors break-all"
                aria-label="XDR Envelope Input"
              />
              {rawXdr && (
                <div className="absolute right-3 bottom-3 flex items-center gap-1.5">
                  <CopyButton text={rawXdr} label="Copy XDR" />
                  <button
                    type="button"
                    onClick={() => setRawXdr('')}
                    className="text-xs px-2 py-1 text-gray-500 hover:text-gray-700 hover:bg-gray-200 rounded border border-gray-200 transition-colors"
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Error State */}
          {error && (
            <div
              className="p-4 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3 text-red-700 text-sm"
              role="alert"
            >
              <AlertCircle className="w-5 h-5 flex-shrink-0 text-red-500 mt-0.5" />
              <div>
                <span className="font-semibold">Decoding Error:</span> {error}
              </div>
            </div>
          )}

          {/* Decoded Overview Card */}
          {decoded && (
            <div className="space-y-6">
              {/* Summary Stats Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-indigo-50/50 p-4 rounded-xl border border-indigo-100">
                <div>
                  <span className="text-xs font-medium text-gray-500 block">Envelope Type</span>
                  <span className="text-xs font-bold text-indigo-900 block truncate">
                    {decoded.envelopeType}
                  </span>
                </div>
                <div>
                  <span className="text-xs font-medium text-gray-500 block">Fee Charged</span>
                  <span className="text-xs font-bold text-gray-900 block">
                    {decoded.fee.xlm} XLM <span className="text-gray-400 font-normal">({decoded.fee.stroops} stroops)</span>
                  </span>
                </div>
                <div>
                  <span className="text-xs font-medium text-gray-500 block">Sequence</span>
                  <span className="text-xs font-mono font-semibold text-gray-900 block truncate">
                    {decoded.sequence}
                  </span>
                </div>
                <div>
                  <span className="text-xs font-medium text-gray-500 block">Operations</span>
                  <span className="text-xs font-bold text-gray-900 block">
                    {decoded.operationCount} operation{decoded.operationCount === 1 ? '' : 's'}
                  </span>
                </div>
              </div>

              {/* Source & Memo Details */}
              <div className="bg-gray-50/70 p-4 rounded-xl border border-gray-200 space-y-3 text-xs">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2 border-b border-gray-200">
                  <div className="flex items-center gap-1.5 text-gray-600 font-medium min-w-0">
                    <Key className="w-4 h-4 text-gray-400 flex-shrink-0" />
                    <span>Source Account:</span>
                    <span className="font-mono text-gray-900 truncate">{decoded.sourceAccount}</span>
                  </div>
                  <CopyButton text={decoded.sourceAccount} label="Copy Address" />
                </div>

                {decoded.isFeeBump && (
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2 border-b border-gray-200">
                    <div className="flex items-center gap-1.5 text-gray-600 font-medium min-w-0">
                      <Shield className="w-4 h-4 text-amber-500 flex-shrink-0" />
                      <span>Fee Source (Fee-Bump):</span>
                      <span className="font-mono text-gray-900 truncate">{decoded.feeSource}</span>
                    </div>
                    <CopyButton text={decoded.feeSource} label="Copy Fee Source" />
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                  <div>
                    <span className="text-gray-500 font-medium">Memo: </span>
                    <span className="font-mono text-gray-800">
                      {decoded.memo.type !== 'none'
                        ? `${decoded.memo.type.toUpperCase()}: ${decoded.memo.value}`
                        : 'None'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5 text-gray-400" />
                    <span className="text-gray-500 font-medium">TimeBounds: </span>
                    <span className="text-gray-800">
                      {decoded.timeBounds
                        ? `${decoded.timeBounds.minTime} → ${decoded.timeBounds.maxTime}`
                        : 'Open (No bounds)'}
                    </span>
                  </div>
                </div>
              </div>

              {/* View Tabs */}
              <div className="flex items-center justify-between border-b border-gray-200">
                <div className="flex space-x-4">
                  <button
                    type="button"
                    onClick={() => setActiveTab('operations')}
                    className={`py-2 text-sm font-semibold border-b-2 transition-colors ${
                      activeTab === 'operations'
                        ? 'border-indigo-600 text-indigo-600'
                        : 'border-transparent text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    Operations ({decoded.operationCount})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('signatures')}
                    className={`py-2 text-sm font-semibold border-b-2 transition-colors ${
                      activeTab === 'signatures'
                        ? 'border-indigo-600 text-indigo-600'
                        : 'border-transparent text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    Signatures ({decoded.signatures.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('raw')}
                    className={`py-2 text-sm font-semibold border-b-2 transition-colors ${
                      activeTab === 'raw'
                        ? 'border-indigo-600 text-indigo-600'
                        : 'border-transparent text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    Raw JSON
                  </button>
                </div>

                {activeTab === 'raw' && (
                  <CopyButton text={JSON.stringify(decoded.rawJson, null, 2)} label="Copy JSON" />
                )}
              </div>

              {/* Tab 1: Operations Breakdown */}
              {activeTab === 'operations' && (
                <div className="space-y-4">
                  {/* Search / Filter operations */}
                  {decoded.operations.length > 1 && (
                    <div className="relative">
                      <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search operations by type, asset, address..."
                        className="w-full pl-9 pr-4 py-2 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        aria-label="Search operations"
                      />
                    </div>
                  )}

                  {filteredOperations.length === 0 ? (
                    <div className="text-center py-8 text-gray-400 text-sm">
                      No matching operations found.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {filteredOperations.map((op) => (
                        <div
                          key={op.index}
                          className="border border-gray-200 rounded-xl overflow-hidden bg-white shadow-sm hover:border-gray-300 transition-all"
                        >
                          <div
                            onClick={() => toggleOp(op.index)}
                            className="p-4 flex items-center justify-between cursor-pointer bg-gray-50/50 hover:bg-gray-50"
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <span className="text-xs font-mono font-bold text-gray-400 bg-gray-200/70 px-2 py-0.5 rounded">
                                #{op.index}
                              </span>
                              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-800">
                                {op.type}
                              </span>
                              <span className="text-sm font-medium text-gray-900 truncate">
                                {op.summary}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <CopyButton text={op.summary} label="Copy" />
                              <button
                                type="button"
                                className="text-gray-400 hover:text-gray-600 p-1"
                                aria-label="Toggle details"
                              >
                                {expandedOps[op.index] ? (
                                  <ChevronUp className="w-4 h-4" />
                                ) : (
                                  <ChevronDown className="w-4 h-4" />
                                )}
                              </button>
                            </div>
                          </div>

                          {/* Expanded attributes */}
                          {expandedOps[op.index] && (
                            <div className="p-4 border-t border-gray-200 bg-white space-y-2">
                              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                                {op.attributes.map((attr, aIdx) => (
                                  <div key={aIdx} className="bg-gray-50 p-2.5 rounded-lg border border-gray-100">
                                    <dt className="text-gray-500 font-medium">{attr.label}</dt>
                                    <dd className="font-mono text-gray-900 break-all font-semibold mt-0.5 flex items-center justify-between gap-2">
                                      <span>{String(attr.value)}</span>
                                      {String(attr.value).length > 15 && (
                                        <CopyButton text={String(attr.value)} label="Copy" className="text-[10px] py-0.5 px-1.5" />
                                      )}
                                    </dd>
                                  </div>
                                ))}
                              </dl>
                              <div className="pt-2">
                                <details className="text-xs">
                                  <summary className="text-gray-500 hover:text-gray-700 cursor-pointer">
                                    View Raw Operation Object
                                  </summary>
                                  <pre className="mt-2 p-2 bg-gray-900 text-gray-100 rounded text-[11px] font-mono overflow-x-auto">
                                    {JSON.stringify(op.raw, null, 2)}
                                  </pre>
                                </details>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Tab 2: Signatures Breakdown */}
              {activeTab === 'signatures' && (
                <div className="space-y-3">
                  {decoded.signatures.length === 0 ? (
                    <div className="text-center py-8 text-gray-400 text-sm">
                      No signatures attached to this envelope.
                    </div>
                  ) : (
                    decoded.signatures.map((sig) => (
                      <div
                        key={sig.index}
                        className="p-3 bg-gray-50 border border-gray-200 rounded-xl space-y-1.5 text-xs font-mono"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-gray-700">Signature #{sig.index}</span>
                          <CopyButton text={sig.signature} label="Copy Signature" />
                        </div>
                        <div className="text-gray-600 break-all">
                          <span className="text-gray-400">Key Hint (Hex): </span>
                          <span className="text-indigo-700 font-bold">{sig.hint}</span>
                        </div>
                        <div className="text-gray-600 break-all">
                          <span className="text-gray-400">Signature (Base64): </span>
                          <span className="text-gray-900">{sig.signature}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* Tab 3: Raw JSON */}
              {activeTab === 'raw' && (
                <div className="relative">
                  <pre className="p-4 bg-gray-900 text-green-400 rounded-xl text-xs font-mono overflow-x-auto max-h-96 whitespace-pre-wrap break-all">
                    {JSON.stringify(decoded.rawJson, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}

          {!rawXdr && !error && (
            <div className="text-center py-12 border-2 border-dashed border-gray-200 rounded-xl">
              <FileCode className="w-10 h-10 text-gray-300 mx-auto mb-2" />
              <p className="text-sm font-medium text-gray-600">No XDR provided</p>
              <p className="text-xs text-gray-400 mt-1 max-w-sm mx-auto">
                Paste a Stellar TransactionEnvelope base64 string above to decode and inspect operations.
              </p>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3 border-t border-gray-200 bg-gray-50/80 flex items-center justify-between">
          <div className="text-xs text-gray-500">
            {txHash && (
              <span className="flex items-center gap-1">
                Linked Tx: <span className="font-mono">{txHash.slice(0, 10)}...</span>
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-gray-800 hover:bg-gray-900 text-white text-xs font-semibold rounded-xl transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
