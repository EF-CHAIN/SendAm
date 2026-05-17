'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { setToken } from '@/lib/auth';
import { Lock } from 'lucide-react';

export default function AdminLogin() {
  const [password, setPassword] = useState('');
  const router = useRouter();

  const handleLogin = (e) => {
    e.preventDefault();
    // Mock login - in a real app, verify via API
    if (password === 'admin123') {
      setToken('mock-jwt-token-for-admin');
      router.push('/admin');
    } else {
      alert('Invalid password. Hint: admin123');
    }
  };

  return (
    <div className="min-h-[80vh] flex items-center justify-center bg-gray-50 px-4 sm:px-6 py-8">
      <div className="bg-white p-6 sm:p-8 rounded-2xl shadow-sm border border-gray-100 w-full max-w-md">
        <div className="flex justify-center mb-6 text-primary">
          <div className="p-4 bg-secondary rounded-full">
            <Lock size={32} />
          </div>
        </div>
        <h2 className="text-2xl font-bold text-center mb-2">Admin Access</h2>
        <p className="text-center text-gray-500 mb-8">Enter your credentials to access the dashboard</p>
        
        <form onSubmit={handleLogin} className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-3 rounded-lg border border-gray-200 focus:ring-2 focus:ring-primary outline-none transition-all"
              placeholder="Enter password"
            />
          </div>
          <button
            type="submit"
            className="w-full bg-dark hover:bg-gray-800 text-white font-medium py-3 rounded-lg transition-colors"
          >
            Sign In
          </button>
        </form>
      </div>
    </div>
  );
}
