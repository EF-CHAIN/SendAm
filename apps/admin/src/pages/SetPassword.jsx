import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { changeAdminPassword } from '@/lib/adminApi';
import { getPasswordStrength, MIN_PASSWORD_LENGTH } from '@/lib/passwordStrength';
import { KeyRound } from 'lucide-react';

const STRENGTH_COLORS = ['bg-gray-200', 'bg-red-600', 'bg-amber-700', 'bg-blue-600', 'bg-teal-600'];
const STRENGTH_LABELS = ['Weak', 'Fair', 'Good', 'Strong'];

// First login with a bootstrap/temporary credential (or a forced rotation)
// lands here so the operator replaces the shared password with a private one.
// The API clears the password-change requirement and revokes every other
// active session once the new password is set.
export default function SetPassword() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const submitting = useRef(false);
  const navigate = useNavigate();
  const strength = useMemo(() => getPasswordStrength(newPassword), [newPassword]);
  const passwordsMatch = confirmPassword.length > 0 && newPassword === confirmPassword;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting.current) return;
    setError('');
    if (!currentPassword) {
      setError('Enter your current password.');
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError('Password must be at least 12 characters.');
      return;
    }
    if (!strength.isStrong) {
      setError('Choose a password with a Strong rating.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    submitting.current = true;
    setLoading(true);
    try {
      await changeAdminPassword({ currentPassword, newPassword });
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.message || 'Could not set a new password.');
    } finally {
      submitting.current = false;
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[80vh] flex items-center justify-center bg-gray-50 px-4 sm:px-6 py-8">
      <div className="bg-white p-6 sm:p-8 rounded-2xl shadow-sm border border-gray-100 w-full max-w-md">
        <div className="flex justify-center mb-6 text-primary">
          <div className="p-4 bg-secondary rounded-full">
            <KeyRound size={32} />
          </div>
        </div>
        <h1 className="text-2xl font-bold text-center mb-2">Set a Private Password</h1>
        <p className="text-center text-gray-500 mb-8">
          This account was provisioned with a shared temporary credential.
          Choose a private password to begin managing the dashboard.
        </p>

        <form onSubmit={handleSubmit} className="space-y-6" aria-busy={loading}>
          <div>
            <label htmlFor="set-password-current" className="block text-sm font-medium text-gray-700 mb-2">Current password</label>
            <input
              id="set-password-current"
              type="password"
              required
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => { setCurrentPassword(e.target.value); setError(''); }}
              disabled={loading}
              className="w-full px-4 py-3 rounded-lg border border-gray-200 focus:ring-2 focus:ring-primary outline-none transition-all"
              placeholder="Temporary password"
            />
          </div>
          <div>
            <label htmlFor="set-password-new" className="block text-sm font-medium text-gray-700 mb-2">New password</label>
            <input
              id="set-password-new"
              type="password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => { setNewPassword(e.target.value); setError(''); }}
              disabled={loading}
              aria-describedby="password-strength-status password-strength-feedback password-requirements"
              className="w-full px-4 py-3 rounded-lg border border-gray-200 focus:ring-2 focus:ring-primary outline-none transition-all"
              placeholder="At least 12 characters"
            />
            <div className="mt-3 space-y-3">
              <p id="password-strength-status" role="status" aria-live="polite" aria-atomic="true" className="text-sm font-medium text-gray-700">
                Password strength: {newPassword ? strength.label : 'Not entered'}
              </p>
              <div
                role="meter"
                aria-label="Password strength"
                aria-valuemin={0}
                aria-valuemax={4}
                aria-valuenow={strength.level}
                aria-valuetext={newPassword ? strength.label : 'Not entered'}
                className="flex gap-2"
              >
                {STRENGTH_LABELS.map((label, index) => (
                  <div key={label} className="flex-1" aria-hidden="true">
                    <div className={`h-2 rounded-full transition-colors duration-300 motion-reduce:transition-none ${index < strength.level ? STRENGTH_COLORS[strength.level] : 'bg-gray-200'}`} />
                    <span className="block mt-1 text-xs text-gray-600">{label}</span>
                  </div>
                ))}
              </div>
              <p id="password-strength-feedback" className="text-sm text-gray-600">{strength.feedback}</p>
              <ul id="password-requirements" aria-label="Password requirements" className="space-y-1 text-sm text-gray-700">
                {[
                  [strength.meetsLength, 'At least 12 characters'],
                  [strength.isStrong, 'Strong rating against common words and patterns'],
                  [passwordsMatch, 'New passwords match'],
                ].map(([met, label]) => (
                  <li key={label} className="flex gap-2">
                    <span aria-hidden="true" className={met ? 'text-teal-700' : 'text-gray-500'}>{met ? '✓' : '○'}</span>
                    <span><span className="sr-only">{met ? 'Met: ' : 'Not met: '}</span>{label}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-gray-500">Length and variety help, but common words and predictable substitutions can still be weak. Strength is an estimate, checked only on this device.</p>
            </div>
          </div>
          <div>
            <label htmlFor="set-password-confirm" className="block text-sm font-medium text-gray-700 mb-2">Confirm new password</label>
            <input
              id="set-password-confirm"
              type="password"
              required
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => { setConfirmPassword(e.target.value); setError(''); }}
              disabled={loading}
              aria-invalid={confirmPassword.length > 0 && !passwordsMatch}
              aria-describedby="password-requirements"
              className="w-full px-4 py-3 rounded-lg border border-gray-200 focus:ring-2 focus:ring-primary outline-none transition-all"
              placeholder="Re-enter new password"
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-red-600 text-center">{error}</p>
          )}
          <button
            type="submit"
            disabled={loading || !strength.isStrong}
            className="w-full bg-dark hover:bg-gray-800 text-white font-medium py-3 rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? 'Setting password...' : 'Set Password'}
          </button>
        </form>
      </div>
    </div>
  );
}
