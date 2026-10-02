import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { isAuthenticated, setToken, removeToken } from "@/lib/auth";
import { sessionBroadcast, SessionEventType } from "@/lib/sessionBroadcast";

export default function ProtectedRoute({ children }) {
  const navigate = useNavigate();
  const [authed, setAuthed] = useState(() => isAuthenticated());

  useEffect(() => {
    // Synchronize authentication status with localStorage
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-sync with localStorage on mount
    setAuthed(isAuthenticated());

    const unsubscribe = sessionBroadcast.subscribe((type, payload) => {
      if (type === SessionEventType.AUTH_LOGOUT) {
        // Remove token locally without re-broadcasting
        removeToken({ broadcast: false });
        setAuthed(false);
        navigate("/login");
      } else if (type === SessionEventType.AUTH_LOGIN && payload?.token) {
        setToken(payload.token, { broadcast: false });
        setAuthed(true);
      }
    });

    return () => unsubscribe();
  }, [navigate]);

  useEffect(() => {
    if (!authed) {
      navigate("/login");
    }
  }, [authed, navigate]);

  if (!authed) {
    return null;
  }

  return children;
}
