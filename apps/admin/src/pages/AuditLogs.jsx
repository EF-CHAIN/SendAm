import { useState, useEffect } from 'react';
import { getAdminAuditLogs, exportAdminAuditLogs } from '@/lib/adminApi';
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
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    getAdminAuditLogs(params)
      .then((res) => {
        setRows(res.data || []);
        setPagination(res.pagination);
      })
      .catch((err) => setError(err.message || 'Failed to fetch audit logs'))
      .finally(() => setLoading(false));
  }, [params]);

  const handleExport = async () => {
    setExporting(true);
    setError('');
    try {
      await exportAdminAuditLogs(params);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to export audit logs');
    } finally {
      setExporting(false);
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
        <h1 className="text-2xl font-bold">Audit Logs</h1>
        <button
          type="button"
          onClick={handleExport}
          disabled={exporting}
          className="text-sm rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium shadow-sm hover:bg-gray-50 disabled:opacity-50"
          data-testid="export-audit"
        >
          {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
      </div>

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
