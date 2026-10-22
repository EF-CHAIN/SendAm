export const CONSENT_STORAGE_KEY = 'sendam_cookie_consent';

/**
 * Retrieves the stored cookie and storage consent preferences.
 * Returns null if the user has not made a choice yet.
 */
export function getStoredConsent() {
  try {
    const raw = localStorage.getItem(CONSENT_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Checks whether user has already accepted or rejected cookie preferences.
 */
export function hasConsentBeenGiven() {
  return getStoredConsent() !== null;
}

/**
 * Checks if user explicitly consented to analytics cookies.
 */
export function hasAnalyticsConsent() {
  const consent = getStoredConsent();
  return Boolean(consent?.analytics);
}

/**
 * Saves consent choices to localStorage and dispatches an event.
 */
export function saveConsent(preferences) {
  const consentData = {
    necessary: true,
    analytics: Boolean(preferences?.analytics),
    marketing: Boolean(preferences?.marketing),
    timestamp: new Date().toISOString(),
    version: '1.0',
  };

  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(consentData));
  } catch {
    // LocalStorage quota or access denied fallback
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('sendam-consent-updated', { detail: consentData })
    );
  }

  return consentData;
}
