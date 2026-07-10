import { useEffect, useState } from 'react';
import { getAdminKyc } from '@/lib/adminApi';
import DataTable from '@/components/DataTable';
import StatusBadge from '@/components/StatusBadge';
import Loader from '@shared/Loader';

export default function KycReview() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getAdminKyc().then((res) => setRows(res.data || [])).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex justify-center py-20"><Loader size={32} /></div>;

  const columns = [
    { header: 'User', render: (row) => row.userId?.phoneNumber || '-' },
    { header: 'Provider', accessor: 'provider' },
    { header: 'Tier', accessor: 'tier' },
    { header: 'Risk', accessor: 'riskScore' },
    { header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    { header: 'Updated', render: (row) => new Date(row.updatedAt).toLocaleString() },
  ];

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">KYC Review</h1>
      <DataTable columns={columns} data={rows} keyField="_id" />
    </div>
  );
}
