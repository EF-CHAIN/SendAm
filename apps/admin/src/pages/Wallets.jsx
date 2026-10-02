import { useState, useEffect, useCallback } from 'react';
import { getAdminWallets } from '@/lib/adminApi';
import { useListQuery } from '@/lib/useListQuery';
import { formatDate } from '@shared/formatDate';
import DataTable from '@/components/DataTable';
import Loader from '@shared/Loader';
import Pagination from '@/components/Pagination';
import FilterBar from '@/components/FilterBar';
import { normalizeError } from '@shared/normalizeError.js';

export default function Wallets() {
  const { params, getFilter, setFilter, resetFilters, goNext, goPrev } = useListQuery(['phone', 'chain', 'fundingState']);
  const [wallets, setWallets] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Incremented by the retry button to re-run the fetch effect.
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    const fetchWallets = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await getAdminWallets(params);
        setWallets(res.data);
        setPagination(res.pagination);
      } catch (err) {
        // normalizeError keeps raw error.message / stack out of the UI
        setError(normalizeError(err).userMessage);
      } finally {
        setLoading(false);
      }
    };
    fetchWallets();
  }, [params, retryCount]);

  const handleRetry = useCallback(() => setRetryCount((c) => c + 1), []);

  const columns = [
    { header: 'User Phone', render: (row) => row.userId?.phoneNumber || 'Unknown' },
    { header: 'Public Key', render: (row) => (
      <span className="font-mono text-xs bg-gray-100 px-2 py-1 rounded text-gray-600">
        {row.publicKey.substring(0, 12)}...{row.publicKey.substring(row.publicKey.length - 4)}
      </span>
    )},
    { header: 'Network', render: (row) => <span className="capitalize">{row.network}</span> },
    { header: 'Created At', render: (row) => formatDate(row.createdAt) },
  ];

  return (
    <div className="min-w-0">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-6">
        <h1 className="text-xl sm:text-2xl font-bold">Wallets</h1>
      </div>

      <FilterBar
        fields={[
          { key: 'phone', label: 'Phone', placeholder: 'Search phone…' },
          { key: 'chain', label: 'Chain', placeholder: 'e.g. stellar' },
          { key: 'fundingState', label: 'Funding', type: 'select', options: ['pending', 'funded', 'failed'] },
        ]}
        getFilter={getFilter}
        setFilter={setFilter}
        onReset={resetFilters}
      />

      {loading ? (
        <div className="flex justify-center py-20"><Loader /></div>
      ) : error ? (
        <div className="text-red-500 p-4 bg-red-50 rounded-lg flex items-center justify-between gap-4" role="alert">
          <span>{error}</span>
          <button
            type="button"
            onClick={handleRetry}
            className="text-sm font-medium underline shrink-0"
          >
            Try Again
          </button>
        </div>
      ) : (
        <>
          <DataTable caption="Wallets" columns={columns} data={wallets} keyField="_id" />
          <Pagination pagination={pagination} onNext={goNext} onPrev={goPrev} />
        </>
      )}
    </div>
  );
}
