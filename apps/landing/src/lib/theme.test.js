import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { THEME_STORAGE_KEY, applyTheme, initTheme, resolveTheme, useTheme } from './theme.js';

/** Stub matchMedia so the OS preference can be switched per test. */
function stubSystemTheme(prefersDark) {
  const listeners = new Set();
  const query = {
    matches: prefersDark,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  window.matchMedia = vi.fn(() => query);
  return {
    change(nextPrefersDark) {
      query.matches = nextPrefersDark;
      listeners.forEach((listener) => listener({ matches: nextPrefersDark }));
    },
  };
}

describe('theme', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.style.colorScheme = '';
  });

  afterEach(() => {
    delete window.matchMedia;
    window.localStorage.clear();
  });

  it('follows the OS preference when nothing is stored', () => {
    stubSystemTheme(true);
    expect(resolveTheme()).toBe('dark');

    stubSystemTheme(false);
    expect(resolveTheme()).toBe('light');
  });

  it('prefers a stored choice over the OS preference', () => {
    stubSystemTheme(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    expect(resolveTheme()).toBe('light');
  });

  it('ignores stored values it does not recognise', () => {
    stubSystemTheme(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'neon');
    expect(resolveTheme()).toBe('light');
  });

  it('falls back to the OS preference when storage throws', () => {
    stubSystemTheme(true);
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(resolveTheme()).toBe('dark');
    getItem.mockRestore();
  });

  it('puts the dark class on <html> only for dark', () => {
    applyTheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');

    applyTheme('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('initTheme applies the resolved theme before render', () => {
    stubSystemTheme(true);
    initTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('toggles, persists the explicit choice, and applies the class', () => {
    stubSystemTheme(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('light');

    act(() => result.current.toggleTheme());

    expect(result.current.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('follows live OS changes until the visitor has made a choice', () => {
    const system = stubSystemTheme(false);
    const { result } = renderHook(() => useTheme());

    act(() => system.change(true));
    expect(result.current.theme).toBe('dark');
  });

  it('stops following the OS once the visitor has chosen a theme', () => {
    const system = stubSystemTheme(false);
    const { result } = renderHook(() => useTheme());

    act(() => result.current.toggleTheme()); // explicit dark
    act(() => system.change(false));

    expect(result.current.theme).toBe('dark');
  });
});
