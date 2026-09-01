import { useState, useEffect } from 'react';
import { 
  getAdminAuditLogs, 
  exportAdminAuditLogs, 
  verifyAdminEventChain, 
  exportAdminWorkflowEvents 
} from '@/lib/adminApi';
import { useListQuery } from '@/lib/useListQuery';
import DataTable from '@/components/DataTable';
import Loader from '@shared/Loader';
import Pagination from '@/components/Pagination';
import FilterBar from '@/components/FilterBar';

export default function AuditLogs() {
  const { params, getFilter, setFilter, resetFilters, goNext, goPrev } = useListQuery([
    'action', 'actorType', 'actorId', 'entityType', 'identifier', 'from', 'to',
  ]);
  const [rows, setRows] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [exportingAudit, setExportingAudit] = useState(false);
  const [exportingEvents, setExportingEvents] = useState(false);
  const [verifyingChain, setVerifyingChain] = useState(false);
  const [chainResult, setChainResult] = useState(null);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    // Same fetch pattern as the other list pages (Users, Wallets,
    // Transactions): loading is toggled inside the async fetch so the spinner
    // shows on every refetch without calling setState synchronously in the
    // effect body (react-hooks/set-state-in-effect).
    const fetchLogs = async () => {
      setLoading(true);
      try {
        const res = await getAdminAuditLogs(params);
        if (!active) return;
        setRows(res.data || []);
        setPagination(res.pagination);
      } catch (err) {
        if (active) setError(err.message || 'Failed to fetch audit logs');
      } finally {
        if (active) setLoading(false);
      }
    };
    fetchLogs();
    return () => {
      active = false;
    };
  }, [params, refreshKey]);

  const handleExportAudit = async () => {
    setExportingAudit(true);
    setError('');
    try {
      await exportAdminAuditLogs(params);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to export audit logs');
    } finally {
      setExportingAudit(false);
    }
  };

  const handleExportEvents = async () => {
    setExportingEvents(true);
    setError('');
    try {
      await exportAdminWorkflowEvents(params);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to export workflow events');
    } finally {
      setExportingEvents(false);
    }
  };

  const handleVerifyChain = async () => {
    setVerifyingChain(true);
    setError('');
    setChainResult(null);
    try {
      const res = await verifyAdminEventChain();
      setChainResult(res.data || res);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to verify event chain integrity');
    } finally {
      setVerifyingChain(false);
    }
  };

  if (loading) return <div className="flex justify-center py-20"><Loader size={32} /></div>;
  const handleRefresh = () => setRefreshKey((prev) => prev + 1);

  const columns = [
    { header: 'Actor', accessor: 'actorType' },
    { header: 'Action', accessor: 'action' },
    { header: 'Entity', render: (row) => row.entityType || '-' },
    { header: 'IP', render: (row) => row.ipAddress || '-' },
    { header: 'Created', render: (row) => new Date(row.createdAt).toLocaleString() },
  ];

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold">Audit Logs</h1>
        <div className="flex gap-2">
        <button
         type="button"
        onClick={handleRefresh}
        className="text-sm rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium shadow-sm hover:bg-gray-50"
        data-testid="refresh-audit"
        >
      Refresh
    </button>
        <button
          type="button"
          onClick={handleExportAudit}
          disabled={exportingAudit}
          className="text-sm rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium shadow-sm hover:bg-gray-50 disabled:opacity-50"
          data-testid="export-audit"
        >
          {exportingAudit ? 'Exporting…' : 'Export CSV'}
        </button>
        <button
          type="button"
          onClick={handleExportEvents}
          disabled={exportingEvents}
          className="text-sm rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium shadow-sm hover:bg-gray-50 disabled:opacity-50"
          data-testid="export-events"
        >
          {exportingEvents ? 'Exporting…' : 'Export Workflow Events'}
        </button>
        <button
          type="button"
          onClick={handleVerifyChain}
          disabled={verifyingChain}
          className="text-sm rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium shadow-sm hover:bg-gray-50 disabled:opacity-50"
          data-testid="verify-chain"
        >
          {verifyingChain ? 'Verifying…' : 'Verify Event Chain'}
        </button>
      </div>
      </div>

      {chainResult && (
        <div className={`mb-4 p-4 rounded-xl border text-sm flex items-center justify-between ${
          chainResult.valid ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-red-50 border-red-200 text-red-900'
        }`}>
          <div>
            <span className="font-bold">
              {chainResult.valid ? '✓ Event Chain Verified Tamper-Resistant' : '✗ Event Chain Verification Failed'}
            </span>
            <span className="ml-2 text-xs opacity-80">
              ({chainResult.total ?? 0} events verified across cryptographic HMAC hash chain)
            </span>
          </div>
          <button type="button" onClick={() => setChainResult(null)} className="text-xs font-semibold hover:underline">
            Dismiss
          </button>
        </div>
      )}

      <FilterBar
        fields={[
          { key: 'action', label: 'Action', placeholder: 'e.g. admin.login' },
          { key: 'actorType', label: 'Actor', placeholder: 'e.g. administrator' },
          {key: 'actorId', label: 'Actor ID', placeholder: 'e.g. Specific actor ID' },
          { key: 'entityType', label: 'Entity', placeholder: 'e.g. Transaction' },
          { key: 'identifier', label: 'ID', placeholder: 'entityId…' },
          { key: 'from', label: 'From', type: 'date' },
          { key: 'to', label: 'To', type: 'date' },
        ]}
        getFilter={getFilter}
        setFilter={setFilter}
        onReset={resetFilters}
      />

      {error && <div className="mb-4 p-3 bg-red-50 text-red-600 border border-red-200 rounded" role="alert">{error}</div>}
      <DataTable columns={columns} data={rows} keyField="_id" />
      <Pagination pagination={pagination} onNext={goNext} onPrev={goPrev} />
    </div>
  );
}
