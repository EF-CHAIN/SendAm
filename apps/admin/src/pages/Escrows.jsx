import { useEffect, useState } from 'react';
import { getAdminEscrows } from '@/lib/adminApi';
import DataTable from '@/components/DataTable';
import StatusBadge from '@/components/StatusBadge';
import Loader from '@shared/Loader';

export default function Escrows() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getAdminEscrows().then((res) => setRows(res.data || [])).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex justify-center py-20"><Loader size={32} /></div>;

  const columns = [
    { header: 'Creator', render: (row) => row.creatorId?.phoneNumber || '-' },
    { header: 'Amount', accessor: 'amount' },
    { header: 'Asset', accessor: 'asset' },
    { header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    { header: 'Chain', accessor: 'chain' },
    { header: 'Created', render: (row) => new Date(row.createdAt).toLocaleString() },
  ];

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Escrow Management</h1>
      <DataTable columns={columns} data={rows} keyField="_id" />
    </div>
  );
}
