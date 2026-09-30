import { useState, useEffect, useCallback, useRef } from 'react';

const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isInStandaloneMode = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

export default function PWABanner() {
  const [showBanner, setShowBanner] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const dismissedRef = useRef(localStorage.getItem('sendam-banner-dismissed') === 'true');

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

  if (!showBanner || isInStandaloneMode) return null;

  if (isIOSDevice) {
    return (
      <div
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
          <p style={{ margin: '4px 0 0', fontSize: '12px', opacity: 0.85 }}>
            Tap the Share button, then "Add to Home Screen"
          </p>
        </div>
        <button
          onClick={handleDismiss}
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
      </div>
    );
  }

  return (
    <div
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
    </div>
  );
}