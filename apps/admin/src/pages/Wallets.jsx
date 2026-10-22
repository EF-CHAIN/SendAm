import { useState, useEffect, useCallback } from 'react';
import { getAdminWallets } from '@/lib/adminApi';
import { useListQuery } from '@/lib/useListQuery';
import { formatDate } from '@shared/formatDate';
import DataTable from '@/components/DataTable';
import Loader from '@shared/Loader';
import Pagination from '@/components/Pagination';
import FilterBar from '@/components/FilterBar';
import { normalizeError } from '@shared/normalizeError.js';
import { AlertTriangle, Copy, Check, X } from 'lucide-react';

export const LOW_RESERVE_THRESHOLD_XLM = 20;
// Stellar base fee per transaction is 100 stroops (0.00001 XLM)
export const STELLAR_BASE_FEE_XLM = 0.00001;
const STROOPS_PER_XLM = 10_000_000;
const BASE_FEE_STROOPS = 100;

export function getWalletXlmBalance(wallet) {
  if (!wallet) return null;
  if (wallet.xlmBalance !== undefined && wallet.xlmBalance !== null) {
    const val = Number(wallet.xlmBalance);
    return isNaN(val) ? null : val;
  }
  if (wallet.balance !== undefined && wallet.balance !== null) {
    const val = Number(wallet.balance);
    return isNaN(val) ? null : val;
  }
  if (wallet.nativeBalance !== undefined && wallet.nativeBalance !== null) {
    const val = Number(wallet.nativeBalance);
    return isNaN(val) ? null : val;
  }
  if (Array.isArray(wallet.balances)) {
    const native = wallet.balances.find((b) => b.asset_type === 'native' || b.asset === 'XLM');
    if (native) {
      const val = Number(native.balance || native.amount || 0);
      return isNaN(val) ? null : val;
    }
  }
  return null;
}

export function calculateTxCapacity(xlmBalance) {
  if (xlmBalance === null || isNaN(xlmBalance)) return null;
  // Available above 1 XLM minimum base reserve. Done in integer stroops because
  // dividing XLM floats (e.g. 1 / 0.00001) lands just below the true integer.
  const spendableStroops = Math.max(0, Math.round((xlmBalance - 1) * STROOPS_PER_XLM));
  return Math.floor(spendableStroops / BASE_FEE_STROOPS);
}

export default function Wallets() {
  const { params, getFilter, setFilter, resetFilters, goNext, goPrev } = useListQuery(['phone', 'chain', 'fundingState']);
  const [wallets, setWallets] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Incremented by the retry button to re-run the fetch effect.
  const [retryCount, setRetryCount] = useState(0);
  const [selectedRefillWallet, setSelectedRefillWallet] = useState(null);
  const [copiedKey, setCopiedKey] = useState(false);

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

  const handleCopyKey = async (key) => {
    if (!key) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(key);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = key;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    } catch (err) {
      console.error('Failed to copy public key:', err);
    }
  };

  const lowReserveWallets = wallets.filter((w) => {
    const bal = getWalletXlmBalance(w);
    return bal !== null && bal < LOW_RESERVE_THRESHOLD_XLM;
  });

  const columns = [
    { header: 'User Phone', render: (row) => row.userId?.phoneNumber || 'Unknown' },
    {
      header: 'Public Key',
      render: (row) => (
        <span className="font-mono text-xs bg-gray-100 px-2 py-1 rounded text-gray-600">
          {row.publicKey ? `${row.publicKey.substring(0, 12)}...${row.publicKey.substring(row.publicKey.length - 4)}` : '—'}
        </span>
      ),
    },
    { header: 'Network', render: (row) => <span className="capitalize">{row.network}</span> },
    {
      header: 'XLM Reserve',
      render: (row) => {
        const bal = getWalletXlmBalance(row);
        if (bal === null) return <span className="text-gray-400">—</span>;
        const isLow = bal < LOW_RESERVE_THRESHOLD_XLM;
        const capacity = calculateTxCapacity(bal);
        return (
          <div className="flex flex-col gap-1 items-start">
            <span
              className={`font-mono text-xs font-semibold ${
                isLow ? 'text-amber-600 dark:text-amber-400' : 'text-gray-800 dark:text-gray-200'
              }`}
            >
              {bal.toFixed(2)} XLM
            </span>
            {isLow ? (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-300">
                  <AlertTriangle className="w-3 h-3" />
                  <span>Low Reserve (&lt;20 XLM)</span>
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedRefillWallet(row)}
                  className="text-[11px] font-semibold text-primary hover:underline"
                  aria-label={`Refill account ${row.publicKey}`}
                >
                  Refill Account
                </button>
              </div>
            ) : (
              <span className="text-[10px] text-gray-500">
                ~{capacity.toLocaleString()} txs capacity
              </span>
            )}
          </div>
        );
      },
    },
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
          {lowReserveWallets.length > 0 && (
            <div
              role="region"
              aria-label="Low XLM Reserve Warning"
              className="mb-6 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-xl p-4 shadow-sm"
            >
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                    Low XLM Base Reserve Warning ({lowReserveWallets.length} account{lowReserveWallets.length === 1 ? '' : 's'})
                  </h2>
                  <p className="mt-1 text-xs sm:text-sm text-amber-800 dark:text-amber-300">
                    {lowReserveWallets.length === 1
                      ? 'An issuing or channel account has dropped below the 20 XLM base reserve threshold. Automated payments will fail if reserves are depleted.'
                      : `${lowReserveWallets.length} accounts have dropped below the 20 XLM base reserve threshold. Automated payments will fail if reserves are depleted.`}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {lowReserveWallets.map((w) => {
                      const bal = getWalletXlmBalance(w);
                      const cap = calculateTxCapacity(bal);
                      return (
                        <div
                          key={w._id || w.id || w.publicKey}
                          className="inline-flex items-center gap-2 px-3 py-1.5 bg-white dark:bg-slate-900 border border-amber-300 dark:border-amber-700 rounded-lg text-xs"
                        >
                          <span className="font-mono text-gray-700 dark:text-gray-300">
                            {w.publicKey ? `${w.publicKey.substring(0, 8)}...` : (w.userId?.phoneNumber || 'Account')}
                          </span>
                          <span className="font-semibold text-amber-700 dark:text-amber-400">
                            {bal.toFixed(2)} XLM
                          </span>
                          {cap !== null && (
                            <span className="text-gray-500 text-[11px]">
                              (~{cap.toLocaleString()} txs capacity)
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => setSelectedRefillWallet(w)}
                            className="ml-1 px-2 py-0.5 bg-amber-600 hover:bg-amber-700 text-white font-medium rounded text-[11px] transition-colors"
                            aria-label={`Refill Account ${w.publicKey}`}
                          >
                            Refill Account
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          <DataTable caption="Wallets" columns={columns} data={wallets} keyField="_id" />
          <Pagination pagination={pagination} onNext={goNext} onPrev={goPrev} />
        </>
      )}

      {/* Refill Account Instructions Modal */}
      {selectedRefillWallet && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          role="dialog"
          aria-modal="true"
          aria-labelledby="refill-modal-title"
        >
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-xl max-w-md w-full p-6 border border-gray-200 dark:border-slate-800">
            <div className="flex items-center justify-between pb-3 border-b border-gray-100 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-600" />
                <h3 id="refill-modal-title" className="text-base font-bold text-gray-900 dark:text-gray-100">
                  Refill Account Instructions
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedRefillWallet(null)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                aria-label="Close refill modal"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="py-4 space-y-4 text-sm text-gray-600 dark:text-gray-300">
              <p>
                This account reserve is below <strong>{LOW_RESERVE_THRESHOLD_XLM} XLM</strong>. To prevent automated payments and fee collection from failing, transfer native XLM to the account address.
              </p>

              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">
                  Public Key (Stellar Destination)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={selectedRefillWallet.publicKey || ''}
                    className="w-full font-mono text-xs p-2 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg text-gray-900 dark:text-gray-100 select-all"
                  />
                  <button
                    type="button"
                    onClick={() => handleCopyKey(selectedRefillWallet.publicKey)}
                    className="p-2 border border-gray-200 dark:border-slate-700 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-600 dark:text-gray-300 transition-colors"
                    aria-label="Copy public key"
                  >
                    {copiedKey ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div className="bg-amber-50 dark:bg-amber-950/40 p-3 rounded-lg border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-300">
                <p className="font-semibold mb-1">Recommended Refill Amount:</p>
                <p>Transfer at least <strong>50 XLM</strong> (or 100+ XLM for high-frequency channels) from your operations treasury to maintain comfortable reserve buffers.</p>
              </div>
            </div>

            <div className="pt-3 border-t border-gray-100 dark:border-slate-800 flex justify-end">
              <button
                type="button"
                onClick={() => setSelectedRefillWallet(null)}
                className="px-4 py-2 bg-gray-100 dark:bg-slate-800 hover:bg-gray-200 dark:hover:bg-slate-700 text-gray-800 dark:text-gray-200 text-sm font-semibold rounded-lg transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
