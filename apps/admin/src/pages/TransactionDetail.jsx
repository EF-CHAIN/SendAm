import { lazy, Suspense, useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronUp, Copy, Check, Code } from 'lucide-react';
import { getAdminTransaction } from '@/lib/adminApi';
import { formatDate } from '@shared/formatDate';
import StatusBadge from '@/components/StatusBadge';
import Loader from '@shared/Loader';
import { exportReceiptPdf } from '@/lib/receiptPdf';
import { Download, FileCode } from 'lucide-react';

// @stellar/stellar-sdk (~900 KB) is only needed once an operator opens the decoder,
// so keep it out of the TransactionDetail route chunk.
const XdrDecoderModal = lazy(() => import('@/components/XdrDecoderModal'));

const Field = ({ label, value, mono = false, children }) => (
  <div className="py-3 sm:grid sm:grid-cols-3 sm:gap-4">
    <dt className="text-sm font-medium text-gray-500">{label}</dt>
    <dd className={`mt-1 text-sm text-gray-900 sm:mt-0 sm:col-span-2 ${mono ? 'font-mono break-all' : ''}`}>
      {children ?? (value !== undefined && value !== null ? String(value) : <span className="text-gray-400">—</span>)}
    </dd>
  </div>
);

const renderJsonWithSyntaxHighlighting = (jsonStr) => {
  if (!jsonStr) return null;
  const jsonRegex = /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*":?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g;
  const parts = [];
  let lastIndex = 0;
  let match;

  while ((match = jsonRegex.exec(jsonStr)) !== null) {
    if (match.index > lastIndex) {
      parts.push(jsonStr.substring(lastIndex, match.index));
    }

    const token = match[0];
    if (token.endsWith(':')) {
      const keyStr = token.slice(0, -1);
      parts.push(
        <span key={match.index} className="text-purple-300 font-semibold">
          {keyStr}
        </span>
      );
      parts.push(':');
    } else if (token.startsWith('"')) {
      parts.push(
        <span key={match.index} className="text-emerald-300">
          {token}
        </span>
      );
    } else if (token === 'true' || token === 'false') {
      parts.push(
        <span key={match.index} className="text-amber-300 font-medium">
          {token}
        </span>
      );
    } else if (token === 'null') {
      parts.push(
        <span key={match.index} className="text-rose-400 italic">
          {token}
        </span>
      );
    } else {
      parts.push(
        <span key={match.index} className="text-sky-300 font-mono">
          {token}
        </span>
      );
    }

    lastIndex = jsonRegex.lastIndex;
  }

  if (lastIndex < jsonStr.length) {
    parts.push(jsonStr.substring(lastIndex));
  }

  return parts;
};

/**
 * Transaction detail / drill-down page.
 * Route: /transactions/:id
 * Closes #324 — operator can inspect every field of a transaction including
 * the explorer link, route metadata, and the linked user phone.
 * Closes #585 — client-side Stellar Horizon XDR transaction envelope decoder and visualizer.
 */
export default function TransactionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [tx, setTx] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showRawJson, setShowRawJson] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isDecoderOpen, setIsDecoderOpen] = useState(false);

  useEffect(() => {
    const fetchTx = async () => {
      setLoading(true);
      try {
        const res = await getAdminTransaction(id);
        setTx(res.data);
      } catch (err) {
        setError(err.response?.data?.message || err.message || 'Failed to load transaction');
      } finally {
        setLoading(false);
      }
    };
    fetchTx();
  }, [id]);

  const handleCopyJson = async (e) => {
    if (e) e.stopPropagation();
    if (!tx) return;
    const jsonString = JSON.stringify(tx, null, 2);
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(jsonString);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = jsonString;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy JSON payload:', err);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-20" aria-label="Loading transaction">
        <Loader />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="mb-4 text-sm text-primary hover:underline"
        >
          ← Back
        </button>
        <div className="p-4 bg-red-50 text-red-600 border border-red-200 rounded" role="alert">
          {error}
        </div>
      </div>
    );
  }

  if (!tx) return null;

  const rawXdr =
    tx.envelopeXdr ||
    tx.metadata?.envelopeXdr ||
    tx.metadata?.xdr ||
    tx.txEnvelope ||
    '';

  return (
    <div className="min-w-0">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-4 min-w-0">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="text-sm text-primary hover:underline flex-shrink-0"
            aria-label="Back to transactions"
          >
            ← Back
          </button>
          <h1 className="text-xl sm:text-2xl font-bold truncate">
            Transaction Detail
          </h1>
          <StatusBadge status={tx.status} />
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setIsDecoderOpen(true)}
            className="inline-flex items-center gap-2 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-xl shadow-sm transition-colors"
            aria-label="Decode Stellar XDR"
          >
            <FileCode className="w-4 h-4" />
            <span>Decode XDR</span>
          </button>
          <button
            type="button"
            onClick={() => exportReceiptPdf(tx)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs sm:text-sm font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg shadow-sm hover:bg-slate-50 transition"
            aria-label="Download PDF Receipt"
          >
            <Download className="w-4 h-4 text-slate-500" />
            <span>Download PDF Receipt</span>
          </button>
        </div>
      </div>

      {isDecoderOpen && (
        <Suspense fallback={null}>
          <XdrDecoderModal
            isOpen={isDecoderOpen}
            onClose={() => setIsDecoderOpen(false)}
            initialXdr={rawXdr}
            txHash={tx.txHash || tx._id || tx.id}
          />
        </Suspense>
      )}

      <div className="bg-white dark:bg-slate-900 shadow-sm border border-gray-200 dark:border-slate-800 rounded-xl overflow-hidden">
        {/* Core identifiers */}
        <div className="px-4 py-3 bg-gray-50 dark:bg-slate-800/60 border-b border-gray-200 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Identifiers</h2>
        </div>
        <dl className="divide-y divide-gray-100 dark:divide-slate-800 px-4">
          <Field label="ID" value={tx._id || tx.id} mono />
          <Field label="Idempotency Key" value={tx.idempotencyKey} mono />
          <Field label="Tx Hash" value={tx.txHash} mono />
          <Field label="Provider Tx ID" value={tx.providerTransactionId} mono />
          <Field label="Explorer">
            {tx.explorerUrl ? (
              <a
                href={tx.explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline break-all"
              >
                {tx.explorerUrl}
              </a>
            ) : <span className="text-gray-400">—</span>}
          </Field>
        </dl>

        {/* Monetary */}
        <div className="px-4 py-3 bg-gray-50 dark:bg-slate-800/60 border-t border-b border-gray-200 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Amount</h2>
        </div>
        <dl className="divide-y divide-gray-100 dark:divide-slate-800 px-4">
          <Field label="Type">
            <span className="capitalize font-medium text-slate-900 dark:text-slate-100">{tx.type}</span>
          </Field>
          <Field label="Amount">
            <span className="font-bold text-slate-900 dark:text-slate-100">{tx.amount} {tx.asset}</span>
          </Field>
          <Field label="Fiat Amount">
            {tx.fiatAmount
              ? <span className="text-slate-900 dark:text-slate-100">{tx.fiatAmount} {tx.fiatCurrency}</span>
              : <span className="text-gray-400">—</span>}
          </Field>
          <Field label="Quote ID" value={tx.quoteId} mono />
        </dl>

        {/* Routing */}
        <div className="px-4 py-3 bg-gray-50 dark:bg-slate-800/60 border-t border-b border-gray-200 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Routing</h2>
        </div>
        <dl className="divide-y divide-gray-100 dark:divide-slate-800 px-4">
          <Field label="Rail">
            <span className="capitalize text-slate-900 dark:text-slate-100">{tx.rail || '—'}</span>
          </Field>
          <Field label="Route Type">
            <span className="capitalize text-slate-900 dark:text-slate-100">{tx.routeType || '—'}</span>
          </Field>
          <Field label="Destination" value={tx.destination} mono />
          <Field label="Recipient Phone" value={tx.recipientPhoneNumber} />
        </dl>

        {/* Parties */}
        <div className="px-4 py-3 bg-gray-50 dark:bg-slate-800/60 border-t border-b border-gray-200 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Parties</h2>
        </div>
        <dl className="divide-y divide-gray-100 dark:divide-slate-800 px-4">
          <Field label="Sender Phone">
            {tx.userId?.phoneNumber
              ? (
                <button
                  type="button"
                  onClick={() => navigate(`/users?phone=${encodeURIComponent(tx.userId.phoneNumber)}`)}
                  className="text-primary hover:underline text-left"
                >
                  {tx.userId.phoneNumber}
                </button>
              )
              : <span className="text-gray-400">—</span>}
          </Field>
          <Field label="User ID" value={typeof tx.userId === 'string' ? tx.userId : tx.userId?.id} mono />
        </dl>

        {/* Timestamps */}
        <div className="px-4 py-3 bg-gray-50 dark:bg-slate-800/60 border-t border-b border-gray-200 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Timestamps</h2>
        </div>
        <dl className="divide-y divide-gray-100 dark:divide-slate-800 px-4">
          <Field label="Created" value={formatDate(tx.createdAt)} />
          <Field label="Updated" value={formatDate(tx.updatedAt)} />
        </dl>

        {/* Metadata */}
        {tx.metadata && Object.keys(tx.metadata).length > 0 && (
          <>
            <div className="px-4 py-3 bg-gray-50 dark:bg-slate-800/60 border-t border-b border-gray-200 dark:border-slate-800">
              <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Metadata</h2>
            </div>
            <div className="px-4 py-4">
              <pre className="text-xs font-mono bg-gray-50 dark:bg-slate-950 p-3 rounded border border-gray-200 dark:border-slate-800 overflow-x-auto whitespace-pre-wrap break-all text-slate-800 dark:text-slate-200">
                {JSON.stringify(tx.metadata, null, 2)}
              </pre>
            </div>
          </>
        )}

        {/* Raw JSON Payload (Collapsible) */}
        <div className="border-t border-gray-200">
          <div className="px-4 py-3 bg-gray-50 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setShowRawJson(!showRawJson)}
              className="flex items-center gap-2 text-sm font-semibold text-gray-700 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
              aria-expanded={showRawJson}
            >
              <Code className="w-4 h-4 text-gray-500 flex-shrink-0" />
              <span>View Raw JSON</span>
              {showRawJson ? (
                <ChevronUp className="w-4 h-4 text-gray-500 ml-1 flex-shrink-0" />
              ) : (
                <ChevronDown className="w-4 h-4 text-gray-500 ml-1 flex-shrink-0" />
              )}
            </button>
            <button
              type="button"
              onClick={handleCopyJson}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1 transition-colors shadow-sm"
              aria-label="Copy JSON"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-green-600" />
                  <span className="text-green-600 font-semibold">Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 text-gray-500" />
                  <span>Copy JSON</span>
                </>
              )}
            </button>
          </div>
          {showRawJson && (
            <div className="p-4 bg-gray-900 text-gray-100 overflow-x-auto">
              <pre className="text-xs font-mono whitespace-pre-wrap break-all leading-relaxed">
                {renderJsonWithSyntaxHighlighting(JSON.stringify(tx, null, 2))}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

