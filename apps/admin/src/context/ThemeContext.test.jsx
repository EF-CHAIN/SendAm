import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from './ThemeContext.jsx';
import { useTheme } from './useTheme.js';
import { THEME_STORAGE_KEY } from './themeConstants.js';
import ThemeToggle from '../components/ThemeToggle.jsx';

function TestComponent() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <div data-testid="theme-val">{theme}</div>
      <div data-testid="resolved-val">{resolvedTheme}</div>
      <button onClick={() => setTheme('light')}>Set Light</button>
      <button onClick={() => setTheme('dark')}>Set Dark</button>
      <button onClick={() => setTheme('system')}>Set System</button>
      <ThemeToggle />
    </div>
  );
}

describe('ThemeContext and ThemeToggle', () => {
  let originalMatchMedia;
  let listeners = [];
  let matchesDark = false;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    listeners = [];
    matchesDark = false;

    originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: matchesDark,
      media: query,
      onchange: null,
      addListener: vi.fn((fn) => listeners.push(fn)),
      removeListener: vi.fn((fn) => {
        listeners = listeners.filter((l) => l !== fn);
      }),
      addEventListener: vi.fn((event, fn) => {
        if (event === 'change') listeners.push(fn);
      }),
      removeEventListener: vi.fn((event, fn) => {
        if (event === 'change') listeners = listeners.filter((l) => l !== fn);
      }),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    document.documentElement.className = '';
    localStorage.clear();
  });

  it('defaults to system theme and light resolved when prefers-color-scheme is light', () => {
    render(
      <ThemeProvider>
        <TestComponent />
      </ThemeProvider>
    );

    expect(screen.getByTestId('theme-val')).toHaveTextContent('system');
    expect(screen.getByTestId('resolved-val')).toHaveTextContent('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('resolves system to dark when prefers-color-scheme matches dark', () => {
    matchesDark = true;
    render(
      <ThemeProvider>
        <TestComponent />
      </ThemeProvider>
    );

    expect(screen.getByTestId('theme-val')).toHaveTextContent('system');
    expect(screen.getByTestId('resolved-val')).toHaveTextContent('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('persists theme in localStorage and updates document root class on toggle', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <TestComponent />
      </ThemeProvider>
    );

    const darkToggle = screen.getByRole('button', { name: /dark theme/i });
    await user.click(darkToggle);

    expect(screen.getByTestId('theme-val')).toHaveTextContent('dark');
    expect(screen.getByTestId('resolved-val')).toHaveTextContent('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    const lightToggle = screen.getByRole('button', { name: /light theme/i });
    await user.click(lightToggle);

    expect(screen.getByTestId('theme-val')).toHaveTextContent('light');
    expect(screen.getByTestId('resolved-val')).toHaveTextContent('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('reads initial theme from localStorage if present', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    render(
      <ThemeProvider>
        <TestComponent />
      </ThemeProvider>
    );

    expect(screen.getByTestId('theme-val')).toHaveTextContent('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('reacts dynamically to system preference change when theme is system', () => {
    render(
      <ThemeProvider>
        <TestComponent />
      </ThemeProvider>
    );

    expect(document.documentElement.classList.contains('dark')).toBe(false);

    // Simulate system switching to dark mode
    act(() => {
      listeners.forEach((listener) => listener({ matches: true }));
    });

    expect(screen.getByTestId('resolved-val')).toHaveTextContent('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
