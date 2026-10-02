import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { SlidersHorizontal } from 'lucide-react';
import { getAdminTransactions, exportAdminTransactions } from '@/lib/adminApi';
import { useListQuery } from '@/lib/useListQuery';
import { formatDate } from '@shared/formatDate';
import { normalizeError } from '@shared/normalizeError.js';
import DataTable from '@/components/DataTable';
import Loader from '@shared/Loader';
import StatusBadge from '@/components/StatusBadge';
import Pagination from '@/components/Pagination';
import FilterBar from '@/components/FilterBar';
import LiveFeedIndicator from '@/components/LiveFeedIndicator';
import { getWebSocketManager } from '@/lib/websocket';

/**
 * Transaction list with full filter support, live feed prepending, and row-level drill-down.
 * Closes #324, #580 — filters: status, asset, rail, phone, userId, identifier,
 * date range. WebSocket stream automatically prepends newly finalized settlements.
 */
export default function Transactions() {
  const navigate = useNavigate();
  const { params, getFilter, setFilter, resetFilters, goNext, goPrev } = useListQuery([
    'status', 'asset', 'rail', 'phone', 'userId', 'identifier', 'from', 'to',
  ]);
  const [showFilters, setShowFilters] = useState(true);
  const [transactions, setTransactions] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [wsState, setWsState] = useState('disconnected');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);

  const handleExport = async () => {
    try {
      setExporting(true);
      setExportError(null);
      await exportAdminTransactions(params);
    } catch (err) {
      setExportError(err.response?.data?.message || 'Failed to export transactions');
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    let active = true;
    const fetchTransactions = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await getAdminTransactions(params);
        if (active) {
          setTransactions(res.data);
          setPagination(res.pagination);
        }
      } catch (err) {
        if (active) setError(normalizeError(err));
      } finally {
        if (active) setLoading(false);
      }
    };
    fetchTransactions();
    return () => { active = false; };
  }, [params]);

  useEffect(() => {
    const wsManager = getWebSocketManager();
    wsManager.connect();
    const unsubState = wsManager.onStateChange((state) => {
      setWsState(state);
    });

    const handleNewTx = (newTx) => {
      if (!newTx) return;
      const tx = newTx.transaction || newTx;
      const txId = tx._id || tx.id;
      if (!txId) return;

      setTransactions((prev) => {
        // Prevent duplicates
        if (prev.some((item) => (item._id || item.id) === txId)) {
          return prev.map((item) => ((item._id || item.id) === txId ? { ...item, ...tx } : item));
        }
        return [tx, ...prev];
      });

      setPagination((prev) => (prev ? { ...prev, total: (prev.total || 0) + 1 } : prev));
    };

    const unsubTx = wsManager.on('transaction', handleNewTx);
    const unsubSettled = wsManager.on('transaction_settled', handleNewTx);
    const unsubCreated = wsManager.on('transaction_created', handleNewTx);

    return () => {
      unsubState();
      unsubTx();
      unsubSettled();
      unsubCreated();
    };
  }, []);

  const columns = [
    { header: 'ID / Hash', render: (row) => (
      <span className="font-mono text-xs text-gray-500">
        {row.txHash ? `${row.txHash.substring(0, 10)}…` : row._id || row.id}
      </span>
    )},
    { header: 'User Phone', render: (row) => row.userId?.phoneNumber || 'Unknown' },
    { header: 'Type', render: (row) => <span className="capitalize font-medium text-gray-700">{row.type}</span> },
    { header: 'Amount', render: (row) => <span className="font-bold">{row.amount} {row.asset}</span> },
    { header: 'Rail', render: (row) => <span className="capitalize">{row.rail}</span> },
    { header: 'Destination', render: (row) => (
      <span className="font-mono text-xs text-gray-500">
        {row.destination ? `${row.destination.substring(0, 8)}…` : '—'}
      </span>
    )},
    { header: 'Receipt', render: (row) => row.explorerUrl ? (
      <a
        href={row.explorerUrl}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="text-primary hover:underline text-sm font-medium"
      >
        View
      </a>
    ) : '—' },
    { header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    { header: 'Date', render: (row) => formatDate(row.createdAt) },
  ];

  return (
    <div className="min-w-0">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-xl sm:text-2xl font-bold">Transactions</h1>
          <LiveFeedIndicator
            state={wsState}
            onReconnect={() => getWebSocketManager().connect()}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-label={showFilters ? 'Hide filters' : 'Show filters'}
            onClick={() => setShowFilters((v) => !v)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium shadow-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
              showFilters
                ? 'border-primary bg-primary text-white hover:bg-accent'
                : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
            Filters
          </button>
          <span className="text-sm text-gray-500 bg-white px-3 py-1 rounded-full border border-gray-200 shadow-sm">
            {pagination?.total != null ? `Total: ${pagination.total}` : ''}
          </span>
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className="text-sm rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium shadow-sm hover:bg-gray-50 disabled:opacity-50"
            data-testid="export-transactions"
          >
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      </div>

      {exportError && (
        <div role="alert" className="mb-4 p-3 bg-red-50 text-red-600 border border-red-200 rounded text-sm">
          {exportError}
        </div>
      )}

      {showFilters && (
        <FilterBar
          fields={[
            { key: 'status', label: 'Status', type: 'select', options: ['pending', 'processing', 'success', 'failed'] },
            { key: 'asset', label: 'Asset', placeholder: 'e.g. USDC' },
            { key: 'rail', label: 'Rail', placeholder: 'e.g. stellar' },
            { key: 'phone', label: 'User Phone', placeholder: 'Search phone…' },
            { key: 'userId', label: 'User ID', placeholder: 'User ID…' },
            { key: 'identifier', label: 'Tx ID / Hash', placeholder: 'id, txHash…' },
            { key: 'from', label: 'From', type: 'date' },
            { key: 'to', label: 'To', type: 'date' },
          ]}
          getFilter={getFilter}
          setFilter={setFilter}
          onReset={resetFilters}
        />
      )}

      {loading ? (
        <div className="flex justify-center py-20"><Loader /></div>
      ) : error ? (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-red-100 bg-red-50 p-6 text-center"
        >
          <p className="mb-4 font-medium text-red-700">{error.userMessage}</p>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setLoading(true);
              getAdminTransactions(params)
                .then((res) => {
                  setTransactions(res.data);
                  setPagination(res.pagination);
                })
                .catch((err) => setError(normalizeError(err)))
                .finally(() => setLoading(false));
            }}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          {/* Rows are clickable — navigates to the drill-down detail page. */}
          <DataTable
            caption="Transactions"
            columns={columns}
            data={transactions}
            keyField="_id"
            onRowClick={(row) => navigate(`/transactions/${row._id || row.id}`)}
            rowClassName="cursor-pointer hover:bg-primary/5 transition-colors"
          />
          <Pagination pagination={pagination} onNext={goNext} onPrev={goPrev} />
        </>
      )}
    </div>
  );
}
