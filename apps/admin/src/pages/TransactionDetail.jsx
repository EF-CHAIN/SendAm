import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getAdminTransaction } from '@/lib/adminApi';
import { formatDate } from '@shared/formatDate';
import StatusBadge from '@/components/StatusBadge';
import Loader from '@shared/Loader';

/**
 * Transaction detail / drill-down page.
 * Route: /transactions/:id
 * Closes #324 — operator can inspect every field of a transaction including
 * the explorer link, route metadata, and the linked user phone.
 */
export default function TransactionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [tx, setTx] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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

  const Field = ({ label, value, mono = false, children }) => (
    <div className="py-3 sm:grid sm:grid-cols-3 sm:gap-4">
      <dt className="text-sm font-medium text-gray-500">{label}</dt>
      <dd className={`mt-1 text-sm text-gray-900 sm:mt-0 sm:col-span-2 ${mono ? 'font-mono break-all' : ''}`}>
        {children ?? (value !== undefined && value !== null ? String(value) : <span className="text-gray-400">—</span>)}
      </dd>
    </div>
  );

  return (
    <div className="min-w-0">
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
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

      <div className="bg-white shadow-sm border border-gray-200 rounded-xl overflow-hidden">
        {/* Core identifiers */}
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-700">Identifiers</h2>
        </div>
        <dl className="divide-y divide-gray-100 px-4">
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
        <div className="px-4 py-3 bg-gray-50 border-t border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-700">Amount</h2>
        </div>
        <dl className="divide-y divide-gray-100 px-4">
          <Field label="Type">
            <span className="capitalize font-medium">{tx.type}</span>
          </Field>
          <Field label="Amount">
            <span className="font-bold">{tx.amount} {tx.asset}</span>
          </Field>
          <Field label="Fiat Amount">
            {tx.fiatAmount
              ? <span>{tx.fiatAmount} {tx.fiatCurrency}</span>
              : <span className="text-gray-400">—</span>}
          </Field>
          <Field label="Quote ID" value={tx.quoteId} mono />
        </dl>

        {/* Routing */}
        <div className="px-4 py-3 bg-gray-50 border-t border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-700">Routing</h2>
        </div>
        <dl className="divide-y divide-gray-100 px-4">
          <Field label="Rail">
            <span className="capitalize">{tx.rail || '—'}</span>
          </Field>
          <Field label="Route Type">
            <span className="capitalize">{tx.routeType || '—'}</span>
          </Field>
          <Field label="Destination" value={tx.destination} mono />
          <Field label="Recipient Phone" value={tx.recipientPhoneNumber} />
        </dl>

        {/* Parties */}
        <div className="px-4 py-3 bg-gray-50 border-t border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-700">Parties</h2>
        </div>
        <dl className="divide-y divide-gray-100 px-4">
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
        <div className="px-4 py-3 bg-gray-50 border-t border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-700">Timestamps</h2>
        </div>
        <dl className="divide-y divide-gray-100 px-4">
          <Field label="Created" value={formatDate(tx.createdAt)} />
          <Field label="Updated" value={formatDate(tx.updatedAt)} />
        </dl>

        {/* Metadata */}
        {tx.metadata && Object.keys(tx.metadata).length > 0 && (
          <>
            <div className="px-4 py-3 bg-gray-50 border-t border-b border-gray-200">
              <h2 className="text-sm font-semibold text-gray-700">Metadata</h2>
            </div>
            <div className="px-4 py-4">
              <pre className="text-xs font-mono bg-gray-50 p-3 rounded border border-gray-200 overflow-x-auto whitespace-pre-wrap break-all">
                {JSON.stringify(tx.metadata, null, 2)}
              </pre>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
