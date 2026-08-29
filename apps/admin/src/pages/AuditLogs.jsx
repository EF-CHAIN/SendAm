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
    'action', 'actorType', 'entityType', 'identifier', 'from', 'to',
  ]);
  const [rows, setRows] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [exportingAudit, setExportingAudit] = useState(false);
  const [exportingEvents, setExportingEvents] = useState(false);
  const [verifyingChain, setVerifyingChain] = useState(false);
  const [chainResult, setChainResult] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchLogs = async () => {
      setLoading(true);
      try {
        const res = await getAdminAuditLogs(params);
        setRows(res.data || []);
        setPagination(res.pagination);
      } catch (err) {
        setError(err.message || 'Failed to fetch audit logs');
      } finally {
        setLoading(false);
      }
    };
    fetchLogs();
  }, [params]);

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
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Audit & Event Ledger</h1>
          <p className="text-xs text-slate-500 mt-1">Durable audit trails and tamper-evident workflow event history (#318, #329)</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleVerifyChain}
            disabled={verifyingChain}
            className="text-xs rounded-lg border border-primary text-primary bg-primary/5 px-3 py-1.5 font-semibold hover:bg-primary/10 transition disabled:opacity-50"
          >
            {verifyingChain ? 'Verifying HMAC Chain…' : 'Verify Event Ledger'}
          </button>
          <button
            type="button"
            onClick={handleExportEvents}
            disabled={exportingEvents}
            className="text-xs rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-medium shadow-sm hover:bg-slate-50 disabled:opacity-50"
          >
            {exportingEvents ? 'Exporting…' : 'Export Events CSV'}
          </button>
          <button
            type="button"
            onClick={handleExportAudit}
            disabled={exportingAudit}
            className="text-xs rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-medium shadow-sm hover:bg-slate-50 disabled:opacity-50"
            data-testid="export-audit"
          >
            {exportingAudit ? 'Exporting…' : 'Export Audit CSV'}
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
