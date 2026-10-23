import { useCallback, useEffect, useState } from 'react';

// Stored only when a visitor picks a theme. Without it the OS preference wins.
export const THEME_STORAGE_KEY = 'sendam-landing-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function readStoredTheme() {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    // Storage can be blocked (private mode, disabled cookies); fall back to the OS.
    return null;
  }
}

function writeStoredTheme(theme) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The choice still applies for this visit.
  }
}

function systemTheme() {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

export function resolveTheme() {
  return readStoredTheme() ?? systemTheme();
}

/** Puts the `dark` class on <html>, which the Tailwind config and index.css key off. */
export function applyTheme(theme) {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

/** Call before first render so the page does not flash the wrong theme. */
export function initTheme() {
  applyTheme(resolveTheme());
}

/**
 * Current landing theme plus a toggle. Follows OS changes live until the visitor
 * makes an explicit choice, after which the stored choice is kept.
 */
export function useTheme() {
  const [theme, setTheme] = useState(resolveTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(DARK_QUERY);
    function onChange(event) {
      if (readStoredTheme() === null) setTheme(event.matches ? 'dark' : 'light');
    }
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);

  const toggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    writeStoredTheme(next);
    setTheme(next);
  }, [theme]);

  return { theme, toggleTheme };
}
