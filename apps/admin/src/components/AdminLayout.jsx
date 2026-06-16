import { Outlet } from 'react-router-dom';
import ProtectedRoute from './ProtectedRoute.jsx';
import AdminSidebar from './AdminSidebar.jsx';

export default function AdminLayout() {
  return (
    <ProtectedRoute>
      <div className="flex flex-col md:flex-row bg-gray-50 min-w-0">
        <AdminSidebar />
        <div className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 md:h-[calc(100vh-73px)] overflow-y-auto">
          <Outlet />
        </div>
      </div>
    </ProtectedRoute>
  );
}
