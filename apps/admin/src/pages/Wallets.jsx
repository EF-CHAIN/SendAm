import { useState, useEffect, useCallback, useMemo } from 'react';
import { getAdminWallets } from '@/lib/adminApi';
import { useListQuery } from '@/lib/useListQuery';
import { formatDate } from '@shared/formatDate';
import DataTable from '@/components/DataTable';
import Loader from '@shared/Loader';
import Pagination from '@/components/Pagination';
import FilterBar from '@/components/FilterBar';
import { normalizeError } from '@shared/normalizeError.js';

// ---------------------------------------------------------------------------
// ReserveAllocationGauge — stacked horizontal progress bar that shows the
// treasury reserve ratio across three custody tiers.
//
// Tier definitions (derived from wallet.network + wallet.fundingState):
//   Hot Reserve   – funded wallets on the stellar mainnet / testnet
//   Channel Accts – pending wallets (payment channel pre-funding queue)
//   Escrow Vaults – any non-stellar wallet or explicitly cold-custody entries
// ---------------------------------------------------------------------------
const TIERS = [
  {
    key: 'hot',
    label: 'Hot Reserve',
    color: 'bg-emerald-500',
    legendColor: 'bg-emerald-500',
    textColor: 'text-emerald-700',
    match: (w) => (w.network === 'stellar' || w.network === 'stellar-testnet') && w.fundingState === 'funded',
  },
  {
    key: 'channel',
    label: 'Channel Accounts',
    color: 'bg-blue-500',
    legendColor: 'bg-blue-500',
    textColor: 'text-blue-700',
    match: (w) => w.fundingState === 'pending',
  },
  {
    key: 'escrow',
    label: 'Escrow Vaults',
    color: 'bg-purple-500',
    legendColor: 'bg-purple-500',
    textColor: 'text-purple-700',
    match: (w) => !TIERS[0].match(w) && !TIERS[1].match(w),
  },
];

function ReserveAllocationGauge({ wallets }) {
  const counts = useMemo(() => {
    const result = TIERS.map((tier) => ({
      ...tier,
      count: wallets.filter(tier.match).length,
    }));
    return result;
  }, [wallets]);

  const total = counts.reduce((s, t) => s + t.count, 0);
  const isEmpty = total === 0;

  return (
    <section
      aria-labelledby="reserve-gauge-heading"
      className="bg-white border border-gray-200 rounded-xl p-4 sm:p-5 mb-6"
    >
      <h2 id="reserve-gauge-heading" className="text-sm font-semibold text-gray-700 mb-3">
        Treasury Reserve Allocation
      </h2>

      {/* Stacked progress bar */}
      <div
        className="flex h-5 w-full rounded-full overflow-hidden bg-gray-100"
        role="group"
        aria-label="Reserve ratio across custody tiers"
      >
        {isEmpty ? (
          <div className="flex-1 bg-gray-200 rounded-full" aria-label="No wallets loaded" />
        ) : (
          counts.map((tier) => {
            const pct = total > 0 ? Math.round((tier.count / total) * 100) : 0;
            if (pct === 0) return null;
            return (
              <div
                key={tier.key}
                className={`${tier.color} transition-all duration-500`}
                style={{ width: `${pct}%` }}
                role="progressbar"
                aria-label={`${tier.label}: ${pct}% (${tier.count} wallet${tier.count !== 1 ? 's' : ''})`}
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
              />
            );
          })
        )}
      </div>

      {/* Legend + numerical totals */}
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
        {counts.map((tier) => {
          const pct = total > 0 ? Math.round((tier.count / total) * 100) : 0;
          return (
            <div key={tier.key} className="flex items-center gap-2">
              <span
                className={`inline-block w-3 h-3 rounded-sm ${tier.legendColor} shrink-0`}
                aria-hidden="true"
              />
              <dt className="sr-only">{tier.label}</dt>
              <dd className="text-xs text-gray-600">
                <span className={`font-semibold ${tier.textColor}`}>{tier.label}</span>
                {' — '}
                <span className="font-mono">{tier.count}</span>
                {total > 0 && (
                  <span className="text-gray-400"> ({pct}%)</span>
                )}
              </dd>
            </div>
          );
        })}
        {total > 0 && (
          <div className="flex items-center gap-2 ml-auto">
            <dt className="text-xs text-gray-500">Total</dt>
            <dd className="text-xs font-semibold text-gray-700 font-mono">{total}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Wallets page
// ---------------------------------------------------------------------------
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
          <ReserveAllocationGauge wallets={wallets} />
          <DataTable caption="Wallets" columns={columns} data={wallets} keyField="_id" />
          <Pagination pagination={pagination} onNext={goNext} onPrev={goPrev} />
        </>
      )}
    </div>
  );
}

