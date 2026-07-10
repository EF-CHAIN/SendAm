import { useEffect, useState } from 'react';
import { getAdminAuditLogs } from '@/lib/adminApi';
import DataTable from '@/components/DataTable';
import Loader from '@shared/Loader';

export default function AuditLogs() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getAdminAuditLogs().then((res) => setRows(res.data || [])).finally(() => setLoading(false));
  }, []);

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
      <h1 className="mb-6 text-2xl font-bold">Audit Logs</h1>
      <DataTable columns={columns} data={rows} keyField="_id" />
    </div>
  );
}
