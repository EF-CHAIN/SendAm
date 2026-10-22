import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CookieConsentBanner from './CookieConsentBanner';
import {
  CONSENT_STORAGE_KEY,
  getStoredConsent,
  hasAnalyticsConsent,
} from '@/lib/consentStorage';

describe('CookieConsentBanner Component', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('renders consent banner on first visit when no consent is stored', () => {
    render(<CookieConsentBanner />);
    expect(screen.getByTestId('cookie-consent-banner')).toBeInTheDocument();
    expect(screen.getByText('Data Privacy & Cookie Choices')).toBeInTheDocument();
    expect(screen.getByTestId('consent-accept-all')).toBeInTheDocument();
    expect(screen.getByTestId('consent-reject-non-essential')).toBeInTheDocument();
  });

  it('does not render banner if consent was previously granted or chosen', () => {
    localStorage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({ necessary: true, analytics: false, marketing: false })
    );

    render(<CookieConsentBanner />);
    expect(screen.queryByTestId('cookie-consent-banner')).toBeNull();
  });

  it('accepts all cookies, persists to localStorage, and hides banner', async () => {
    const listener = vi.fn();
    window.addEventListener('sendam-consent-updated', listener);

    render(<CookieConsentBanner />);
    const acceptBtn = screen.getByTestId('consent-accept-all');
    fireEvent.click(acceptBtn);

    expect(screen.queryByTestId('cookie-consent-banner')).toBeNull();

    const stored = getStoredConsent();
    expect(stored.necessary).toBe(true);
    expect(stored.analytics).toBe(true);
    expect(stored.marketing).toBe(true);
    expect(hasAnalyticsConsent()).toBe(true);
    expect(listener).toHaveBeenCalled();
  });

  it('rejects non-essential cookies, persists to localStorage, and hides banner', () => {
    render(<CookieConsentBanner />);
    const rejectBtn = screen.getByTestId('consent-reject-non-essential');
    fireEvent.click(rejectBtn);

    expect(screen.queryByTestId('cookie-consent-banner')).toBeNull();

    const stored = getStoredConsent();
    expect(stored.necessary).toBe(true);
    expect(stored.analytics).toBe(false);
    expect(stored.marketing).toBe(false);
    expect(hasAnalyticsConsent()).toBe(false);
  });

  it('opens granular preferences modal, allows custom toggle selection, and saves preferences', async () => {
    render(<CookieConsentBanner />);

    // Click customize button
    const customizeBtn = screen.getByTestId('consent-customize');
    fireEvent.click(customizeBtn);

    // Modal opens
    expect(screen.getByTestId('consent-preferences-modal')).toBeInTheDocument();
    expect(screen.getByText('Cookie & Privacy Preferences')).toBeInTheDocument();
    expect(screen.getByText('Always Active')).toBeInTheDocument();

    // Toggle analytics on
    const analyticsToggle = screen.getByTestId('consent-toggle-analytics');
    expect(analyticsToggle.checked).toBe(false);
    fireEvent.click(analyticsToggle);
    expect(analyticsToggle.checked).toBe(true);

    // Save preferences
    const saveBtn = screen.getByTestId('consent-save-preferences');
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(screen.queryByTestId('consent-preferences-modal')).toBeNull();
      expect(screen.queryByTestId('cookie-consent-banner')).toBeNull();
    });

    const stored = getStoredConsent();
    expect(stored.necessary).toBe(true);
    expect(stored.analytics).toBe(true);
    expect(stored.marketing).toBe(false);
  });

  it('closes preferences modal when Escape is pressed', () => {
    render(<CookieConsentBanner />);
    fireEvent.click(screen.getByTestId('consent-customize'));
    expect(screen.getByTestId('consent-preferences-modal')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('consent-preferences-modal')).toBeNull();
  });
});
