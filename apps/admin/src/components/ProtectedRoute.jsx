import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { isAuthenticated } from '@/lib/auth';

export default function ProtectedRoute({ children }) {
  const navigate = useNavigate();
  // isAuthenticated() is a synchronous token check, so derive it during render
  // and only use the effect for the redirect side effect.
  const authed = isAuthenticated();

  useEffect(() => {
    if (!authed) {
      navigate('/login');
    }
  }, [authed, navigate]);

  if (!authed) {
    return null;
  }

  return children;
}
