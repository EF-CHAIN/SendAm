import { useState, useEffect, useCallback, useRef } from 'react';

// Only Safari can "Add to Home Screen" on iOS; Chrome/Firefox/Edge there cannot.
const isIOSSafari =
  /iPad|iPhone|iPod/.test(navigator.userAgent) &&
  !window.MSStream &&
  !/CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent);
const IOS_DISMISSED_KEY = 'sendam-ios-install-dismissed';
const isInStandaloneMode = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

export default function PWABanner() {
  const [showBanner, setShowBanner] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const dismissedRef = useRef(localStorage.getItem('sendam-banner-dismissed') === 'true');
  const [online, setOnline] = useState(navigator.onLine);
  const [showBackOnline, setShowBackOnline] = useState(false);
  const [iosDismissed, setIosDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(IOS_DISMISSED_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const handleInstall = useCallback(async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    setShowBanner(false);
    dismissedRef.current = true;
    localStorage.setItem('sendam-banner-dismissed', 'true');
  }, [deferredPrompt]);

  const handleDismiss = useCallback(() => {
    setShowBanner(false);
    dismissedRef.current = true;
    localStorage.setItem('sendam-banner-dismissed', 'true');
  }, []);

  const handleIosDismiss = useCallback(() => {
    setIosDismissed(true);
    try {
      sessionStorage.setItem(IOS_DISMISSED_KEY, 'true');
    } catch {
      // Private mode: the banner just reappears next page load.
    }
  }, []);

  useEffect(() => {
    const goOffline = () => {
      setOnline(false);
      setShowBackOnline(false);
    };
    const goOnline = () => {
      setOnline(true);
      setShowBackOnline(true);
    };
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);

  useEffect(() => {
    if (!showBackOnline) return undefined;
    const timer = setTimeout(() => setShowBackOnline(false), 3000);
    return () => clearTimeout(timer);
  }, [showBackOnline]);

  useEffect(() => {
    if (isInStandaloneMode || dismissedRef.current) {
      return;
    }

    const handler = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setShowBanner(true);
    };
    window.addEventListener('beforeinstallprompt', handler);

    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
    };
  }, []);

  const installBanner = isInStandaloneMode
    ? null
    : isIOSSafari
      ? iosDismissed
        ? null
        : (<div
        role="dialog"
        aria-label="Install SendAm on iOS"
        style={{
          position: 'fixed',
          bottom: '16px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 9999,
          backgroundColor: '#0d9488',
          color: '#fff',
          borderRadius: '12px',
          padding: '16px 24px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '12px',
          maxWidth: '400px',
          width: 'calc(100% - 32px)',
          fontFamily: 'Inter, sans-serif',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <p style={{ margin: 0, fontWeight: 600, fontSize: '14px' }}>Install SendAm</p>
          <ol style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', fontSize: '12px', opacity: 0.9, textAlign: 'left' }}>
            <li style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              1. Tap the Share icon
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7" />
              </svg>
              in Safari's toolbar
            </li>
            <li>2. Scroll down and tap "Add to Home Screen"</li>
            <li>3. Tap "Add"</li>
          </ol>
        </div>
        <button
          onClick={handleIosDismiss}
          aria-label="Dismiss install banner"
          style={{
            background: 'rgba(255,255,255,0.2)',
            border: 'none',
            color: '#fff',
            borderRadius: '8px',
            padding: '8px 16px',
            cursor: 'pointer',
            fontSize: '12px',
            fontWeight: 600,
          }}
        >
          Got it
        </button>
      </div>)
      : showBanner
        ? (<div
      role="dialog"
      aria-label="Install SendAm"
      style={{
        position: 'fixed',
        bottom: '16px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        backgroundColor: '#0d9488',
        color: '#fff',
        borderRadius: '12px',
        padding: '16px 24px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        maxWidth: '400px',
        width: 'calc(100% - 32px)',
        fontFamily: 'Inter, sans-serif',
      }}
    >
      <div style={{ flex: 1 }}>
        <p style={{ margin: 0, fontWeight: 600, fontSize: '14px' }}>Install SendAm</p>
        <p style={{ margin: '4px 0 0', fontSize: '12px', opacity: 0.85 }}>
          Add to home screen for the best experience on mobile
        </p>
      </div>
      <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
        <button
          onClick={handleDismiss}
          aria-label="Dismiss install banner"
          style={{
            background: 'rgba(255,255,255,0.2)',
            border: 'none',
            color: '#fff',
            borderRadius: '8px',
            padding: '8px 12px',
            cursor: 'pointer',
            fontSize: '12px',
            fontWeight: 600,
          }}
        >
          Dismiss
        </button>
        <button
          onClick={handleInstall}
          aria-label="Install SendAm"
          style={{
            background: '#fff',
            color: '#0d9488',
            border: 'none',
            borderRadius: '8px',
            padding: '8px 12px',
            cursor: 'pointer',
            fontSize: '12px',
            fontWeight: 700,
          }}
        >
          Install
        </button>
      </div>
    </div>)
        : null;

  return (
    <>
      {!online && (
        <div
          role="status"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 10000,
            backgroundColor: '#334155',
            color: '#fff',
            padding: '8px 16px',
            fontSize: '12px',
            fontWeight: 600,
            textAlign: 'center',
            fontFamily: 'Inter, sans-serif',
          }}
        >
          You're offline. Rates are cached and will sync automatically when you reconnect.
        </div>
      )}
      {showBackOnline && (
        <div
          role="status"
          style={{
            position: 'fixed',
            top: '16px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 10000,
            backgroundColor: '#16a34a',
            color: '#fff',
            borderRadius: '8px',
            padding: '8px 16px',
            fontSize: '13px',
            fontWeight: 600,
            boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
            fontFamily: 'Inter, sans-serif',
          }}
        >
          Back online
        </div>
      )}
      {installBanner}
    </>
  );
}
