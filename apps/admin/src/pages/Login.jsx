import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminLogin } from '@/lib/adminApi';
import { Eye, EyeOff, Loader2, Lock } from 'lucide-react';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await adminLogin(email, password);
      if (result?.token) {
        // A bootstrap/temporary credential only authenticates the self-serve
        // password rotation: force the operator to pick a private password
        // before any admin work.
        if (result.mustChangePassword) {
          navigate('/set-password');
        } else {
          navigate('/');
        }
      } else {
        setError('Login failed. Please try again.');
      }
    } catch (err) {
      const message = err.response?.data?.message || 'Invalid credentials';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-[80vh] flex items-center justify-center bg-gray-50 px-4 sm:px-6 py-8">
      <div className="bg-white p-6 sm:p-8 rounded-2xl shadow-sm border border-gray-100 w-full max-w-md">
        <div className="flex justify-center mb-6 text-primary">
          <div className="p-4 bg-secondary rounded-full">
            <Lock size={32} />
          </div>
        </div>
        <h1 className="text-2xl font-bold text-center mb-2">Admin Access</h1>
        <p className="text-center text-gray-500 mb-8">Enter your credentials to access the dashboard</p>

        <form onSubmit={handleLogin} className="space-y-6">
          <div>
            <label htmlFor="login-email" className="block text-sm font-medium text-gray-700 mb-2">Email</label>
            <input id="login-email" type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={error ? 'true' : undefined} aria-describedby={error ? 'login-error' : undefined} className="w-full px-4 py-3 rounded-lg border border-gray-200 focus:ring-2 focus:ring-primary outline-none transition-all" placeholder="you@example.com" />
          </div>
          <div>
            <label htmlFor="login-password" className="block text-sm font-medium text-gray-700 mb-2">Password</label>
            <div className="relative">
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={error ? 'true' : undefined}
                aria-describedby={error ? 'login-error' : undefined}
                className="w-full px-4 py-3 pr-12 rounded-lg border border-gray-200 focus:ring-2 focus:ring-primary outline-none transition-all"
                placeholder="Enter password"
              />
              <button
                type="button"
                onClick={() => setShowPassword((visible) => !visible)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute inset-y-0 right-0 flex items-center px-4 text-gray-500 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary rounded-r-lg"
              >
                {showPassword ? <EyeOff size={20} aria-hidden="true" /> : <Eye size={20} aria-hidden="true" />}
              </button>
            </div>
          </div>
          {error && (
            <p id="login-error" role="alert" className="text-sm text-red-600 text-center">{error}</p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-dark hover:bg-gray-800 text-white font-medium py-3 rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 size={18} className="animate-spin" aria-hidden="true" />
                Signing in...
              </span>
            ) : 'Sign In'}
          </button>
        </form>
      </div>
    </main>
  );
}
