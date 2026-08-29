import { useState, useEffect } from 'react';
import { getAdminKyc, approveKyc, rejectKyc, exportAdminKyc } from '@/lib/adminApi';
import { useListQuery } from '@/lib/useListQuery';
import DataTable from '@/components/DataTable';
import StatusBadge from '@/components/StatusBadge';
import Loader from '@shared/Loader';
import Pagination from '@/components/Pagination';
import FilterBar from '@/components/FilterBar';

export default function KycReview() {
  const { params, getFilter, setFilter, resetFilters, goNext, goPrev } = useListQuery(['status', 'phone', 'country']);
  const [rows, setRows] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    getAdminKyc(params)
      .then((res) => {
        if (active) {
          setRows(res.data || []);
          setPagination(res.pagination);
        }
      })
      .catch((err) => {
        if (active) setError(err.message || 'Failed to fetch KYC profiles');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [params]);

  const handleApprove = async (id) => {
    setMutatingId(id);
    setError('');
    try {
      await approveKyc(id);
      setRows((prev) => prev.map((r) => r._id === id ? { ...r, status: 'approved' } : r));
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to approve KYC');
    } finally {
      setMutatingId(null);
    }
  };

  const handleReject = async (id) => {
    setMutatingId(id);
    setError('');
    try {
      await rejectKyc(id);
      setRows((prev) => prev.map((r) => r._id === id ? { ...r, status: 'rejected' } : r));
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to reject KYC');
    } finally {
      setMutatingId(null);
    }
  };

  const [mutatingId, setMutatingId] = useState(null);

  const handleExport = async () => {
    setExporting(true);
    setError('');
    try {
      await exportAdminKyc(params);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to export KYC');
    } finally {
      setExporting(false);
    }
  };

  if (loading) return <div className="flex justify-center py-20" data-testid="kyc-loading"><Loader size={32} /></div>;

  const columns = [
    { header: 'User', render: (row) => row.userId?.phoneNumber || '-' },
    { header: 'Provider', accessor: 'provider' },
    { header: 'Tier', accessor: 'tier' },
    { header: 'Risk', accessor: 'riskScore' },
    { header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    { header: 'Updated', render: (row) => new Date(row.updatedAt).toLocaleString() },
    { header: 'Actions', render: (row) => (
      ['pending', 'review'].includes(row.status) && (
        <div className="flex gap-2">
          <button
            onClick={() => handleApprove(row._id)}
            disabled={mutatingId === row._id}
            className="px-3 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
          >
            Approve
          </button>
          <button
            onClick={() => handleReject(row._id)}
            disabled={mutatingId === row._id}
            className="px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      )
    )}
  ];

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold">KYC Review</h1>
        <button
          type="button"
          onClick={handleExport}
          disabled={exporting}
          className="text-sm rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium shadow-sm hover:bg-gray-50 disabled:opacity-50"
          data-testid="export-kyc"
        >
          {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
      </div>

      <FilterBar
        fields={[
          { key: 'status', label: 'Status', type: 'select', options: ['not_started', 'pending', 'review', 'approved', 'rejected'] },
          { key: 'phone', label: 'Phone', placeholder: 'Search phone…' },
          { key: 'country', label: 'Country', placeholder: 'e.g. NG' },
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
