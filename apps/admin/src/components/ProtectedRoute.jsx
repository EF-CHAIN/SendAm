import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { isAuthenticated, setToken, removeToken } from "@/lib/auth";
import { sessionBroadcast, SessionEventType } from "@/lib/sessionBroadcast";
import { adminLogout, renewAdminSession } from "@/lib/adminApi";

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const WARNING_SECONDS = 60;

export default function ProtectedRoute({ children }) {
  const navigate = useNavigate();
  const [authed, setAuthed] = useState(() => isAuthenticated());
  const [showWarning, setShowWarning] = useState(false);
  const [countdown, setCountdown] = useState(WARNING_SECONDS);
  const [lastActivityAt, setLastActivityAt] = useState(0);

  useEffect(() => {
    // Synchronize authentication status with localStorage and other tabs.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-sync with localStorage on mount
    setAuthed(isAuthenticated());

    const unsubscribe = sessionBroadcast.subscribe((type, payload) => {
      if (type === SessionEventType.AUTH_LOGOUT) {
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

  useEffect(() => {
    if (!authed || showWarning) return undefined;

    const idleTimer = window.setTimeout(() => {
      setCountdown(WARNING_SECONDS);
      setShowWarning(true);
    }, IDLE_TIMEOUT_MS);
    const onActivity = () => setLastActivityAt(Date.now());
    const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"];
    events.forEach((eventName) => window.addEventListener(eventName, onActivity, { passive: true }));

    return () => {
      window.clearTimeout(idleTimer);
      events.forEach((eventName) => window.removeEventListener(eventName, onActivity));
    };
  }, [authed, lastActivityAt, showWarning]);

  useEffect(() => {
    if (!showWarning) return undefined;
    const interval = window.setInterval(() => {
      setCountdown((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [showWarning]);

  useEffect(() => {
    if (!showWarning || countdown > 0) return undefined;

    const expireSession = async () => {
      try {
        await adminLogout();
      } catch {
        // Clear the local session even if the server is unreachable.
      } finally {
        removeToken();
        setAuthed(false);
        navigate("/login", { replace: true });
      }
    };
    expireSession();
    return undefined;
  }, [countdown, navigate, showWarning]);

  const stayLoggedIn = async () => {
    try {
      await renewAdminSession();
      setShowWarning(false);
      setCountdown(WARNING_SECONDS);
      setLastActivityAt(Date.now());
    } catch {
      removeToken();
      setAuthed(false);
      navigate("/login", { replace: true });
    }
  };

  if (!authed) return null;

  return (
    <>
      {children}
      {showWarning && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="idle-session-title"
          aria-describedby="idle-session-description"
          className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50 p-4"
        >
          <div className="w-full max-w-md rounded-xl bg-white p-6 text-slate-900 shadow-xl">
            <h2 id="idle-session-title" className="text-lg font-semibold">Still there?</h2>
            <p id="idle-session-description" className="mt-2">
              You have been inactive. For your security, you will be logged out in{" "}
              <strong aria-live="polite">{countdown}</strong> seconds.
            </p>
            <button
              type="button"
              onClick={stayLoggedIn}
              className="mt-5 rounded-lg bg-slate-900 px-4 py-2 font-medium text-white"
            >
              Stay Logged In
            </button>
          </div>
        </div>
      )}
    </>
  );
}
