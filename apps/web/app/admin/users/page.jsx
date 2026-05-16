'use client';
import { useState, useEffect } from 'react';
import { getAdminUsers } from '@/lib/adminApi';
import { formatDate } from '@/lib/formatDate';
import DataTable from '@/components/DataTable';
import Loader from '@/components/Loader';
import StatusBadge from '@/components/StatusBadge';

export default function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const res = await getAdminUsers();
        setUsers(res.data);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchUsers();
  }, []);

  const columns = [
    { header: 'Phone Number', accessor: 'phoneNumber' },
    { header: 'WhatsApp Name', render: (row) => row.whatsappName || <span className="text-gray-400 italic">Unknown</span> },
    { header: 'Wallet Status', render: (row) => <StatusBadge status={row.walletId ? 'Created' : 'Pending'} /> },
    { header: 'Network', render: (row) => row.walletId?.network || '-' },
    { header: 'Created At', render: (row) => formatDate(row.createdAt) },
  ];

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Users</h1>
        <span className="text-sm text-gray-500 bg-white px-3 py-1 rounded-full border border-gray-200 shadow-sm">
          Total: {users.length}
        </span>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader /></div>
      ) : (
        <DataTable columns={columns} data={users} keyField="_id" />
      )}
    </div>
  );
}
