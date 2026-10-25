import { useTheme } from '../context/useTheme';
import { Sun, Moon, Laptop, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';

const HIGH_CONTRAST_CSS = `
  [data-high-contrast="true"] {
    color-scheme: contrast;
  }
  [data-high-contrast="true"] * {
    border-color: #000000 !important;
    border-width: 2px !important;
    border-style: solid !important;
  }
  [data-high-contrast="true"] body,
  [data-high-contrast="true"] #root,
  [data-high-contrast="true"] .bg-white,
  [data-high-contrast="true"] .bg-gray-100,
  [data-high-contrast="true"] .bg-slate-50,
  [data-high-contrast="true"] .bg-emerald-100,
  [data-high-contrast="true"] .bg-red-100,
  [data-high-contrast="true"] .bg-amber-50,
  [data-high-contrast="true"] .bg-blue-50 {
    background-color: #000000 !important;
  }
  [data-high-contrast="true"] .dark\\:bg-gray-800,
  [data-high-contrast="true"] .dark\\:bg-slate-800 {
    background-color: #000000 !important;
  }
  [data-high-contrast="true"] .text-gray-900,
  [data-high-contrast="true"] .text-slate-900,
  [data-high-contrast="true"] .text-red-900,
  [data-high-contrast="true"] .text-amber-800,
  [data-high-contrast="true"] .text-emerald-800,
  [data-high-contrast="true"] .text-gray-600,
  [data-high-contrast="true"] .text-slate-700,
  [data-high-contrast="true"] .text-slate-600 {
    color: #ffffff !important;
  }
  [data-high-contrast="true"] .text-gray-400,
  [data-high-contrast="true"] .text-slate-400,
  [data-high-contrast="true"] .text-gray-500 {
    color: #cccccc !important;
  }
  [data-high-contrast="true"] button,
  [data-high-contrast="true"] a,
  [data-high-contrast="true"] input,
  [data-high-contrast="true"] select,
  [data-high-contrast="true"] textarea {
    border: 2px solid #000000 !important;
    background-color: #000000 !important;
    color: #ffffff !important;
  }
  [data-high-contrast="true"] button:hover,
  [data-high-contrast="true"] button:focus {
    background-color: #1a1a1a !important;
  }
`;

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [highContrast, setHighContrast] = useState(() => {
    try {
      return localStorage.getItem('sendam_admin_high_contrast') === 'true';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('sendam_admin_high_contrast', String(highContrast));
    } catch {
      // Ignore localStorage errors
    }
    if (highContrast) {
      document.documentElement.setAttribute('data-high-contrast', 'true');
    } else {
      document.documentElement.removeAttribute('data-high-contrast');
    }
  }, [highContrast]);

  const options = [
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
    { value: 'system', label: 'System', icon: Laptop },
  ];

  return (
    <>
    <div
      role="group"
      aria-label="Theme preference"
      className="inline-flex items-center p-1 rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-xs font-medium"
    >
      {options.map((opt) => {
        const Icon = opt.icon;
        const isSelected = theme === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={isSelected}
            aria-label={`${opt.label} theme`}
            title={`${opt.label} theme`}
            onClick={() => setTheme(opt.value)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-all ${
              isSelected
                ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm font-semibold'
                : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
            }`}
          >
            <Icon className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">{opt.label}</span>
          </button>
        );
      })}
      <button
        type="button"
        aria-pressed={highContrast}
        aria-label={highContrast ? 'Disable high contrast mode' : 'Enable high contrast mode'}
        title={highContrast ? 'Disable high contrast mode' : 'Enable high contrast mode'}
        onClick={() => setHighContrast((prev) => !prev)}
        className={`ml-2 flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-all ${
          highContrast
            ? 'bg-black text-white border border-white shadow-sm font-semibold'
            : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
        }`}
      >
        <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">
          {highContrast ? 'High Contrast On' : 'High Contrast'}
        </span>
      </button>
    </div>
    <style>{HIGH_CONTRAST_CSS}</style>
    </>
  );
}
