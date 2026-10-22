import { useEffect, useId, useRef, useState } from 'react';

// Typing fires one query per keystroke without this quiet period, which makes
// the table flicker and lets a slow response for an earlier keystroke land
// after a later one (race condition). #750
export const SEARCH_DEBOUNCE_MS = 300;

// Local-time calendar day as yyyy-mm-dd — the value format <input type="date">
// holds, and what the API's from/to filters read. Built from local date parts
// on purpose: an operator filtering "Today" means their today, and
// toISOString() would shift the day across the UTC boundary.
function isoDay(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function daysAgo(now, days) {
  const result = new Date(now);
  result.setDate(result.getDate() - days);
  return result;
}

// Quick ranges for daily reconciliation. Each returns [start, end] dates;
// both bounds are inclusive calendar days.
const DATE_PRESETS = [
  { label: 'Today', range: (now) => [now, now] },
  { label: 'Yesterday', range: (now) => [daysAgo(now, 1), daysAgo(now, 1)] },
  { label: 'Last 7 Days', range: (now) => [daysAgo(now, 6), now] },
  { label: 'Month to Date', range: (now) => [new Date(now.getFullYear(), now.getMonth(), 1), now] },
  { label: 'Year to Date', range: (now) => [new Date(now.getFullYear(), 0, 1), now] },
];

const presetTestId = (label) => `filter-preset-${label.toLowerCase().replace(/ /g, '-')}`;

// Draft state for a typed filter (text/date input). Keystrokes render into the
// local draft immediately — typing stays responsive — while `commit` (and with
// it the URL and the list query) only runs after `delay` ms of quiet typing.
//
// The draft re-syncs whenever the committed value changes somewhere else (chip
// dismissal, Clear All, a date preset, back/forward, a shared URL load), and a
// pending timer is cancelled at that point so a stale keystroke can never
// overwrite the external change.
function useDebouncedDraft(value, commit, delay = SEARCH_DEBOUNCE_MS) {
  const [draft, setDraft] = useState(value);
  const timerRef = useRef(null);
  const committedRef = useRef(value);

  useEffect(() => {
    if (value === committedRef.current) return;
    committedRef.current = value;
    clearTimeout(timerRef.current);
    setDraft(value);
  }, [value]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const changeDraft = (next) => {
    setDraft(next);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      // A draft that round-trips back to the committed value must not commit:
      // setFilter would clear the cursor window for a filter that never changed.
      if (next === committedRef.current) return;
      committedRef.current = next;
      commit(next);
    }, delay);
  };

  return [draft, changeDraft];
}

// A single debounced text/date filter control. Kept as its own component so
// each field owns its own draft and timer (hooks cannot live in the fields map).
function FilterInput({ field, id, value, setFilter }) {
  const [draft, changeDraft] = useDebouncedDraft(value, (next) => setFilter(field.key, next));
  return (
    <input
      id={id}
      type={field.type || 'text'}
      className="text-sm rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-gray-900 dark:text-gray-100 px-3 py-1.5 shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
      placeholder={field.placeholder || ''}
      value={draft}
      onChange={(e) => changeDraft(e.target.value)}
      data-testid={`filter-${field.key}`}
    />
  );
}

// Reusable filter bar for admin list pages. `fields` is an array of
// { key, label, placeholder?, type?: 'text' | 'select', options?: string[] }.
// Values are read from the URL via `getFilter` and written via `setFilter`,
// which keeps them in sync with the shared list query state.
//
// Each control is tied to its visible label via `htmlFor`/`id` rather than by
// nesting it inside the <label>. Implicit (wrapping) labels are resolved
// inconsistently by some screen readers and voice-control tools, so the
// explicit association guarantees every filter's accessible name is exactly
// its label text. `useId` keeps ids unique when several bars share a page.
export default function FilterBar({ fields = [], getFilter, setFilter, onReset }) {
  const idPrefix = useId();
  return (
    <form
      className="flex flex-wrap items-end gap-3 mb-4"
      onSubmit={(e) => e.preventDefault()}
    >
      {fields.map((field) => {
        const value = getFilter(field.key);
        const common = 'text-sm rounded-lg border border-gray-200 bg-white px-3 py-1.5 shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/40';
        const id = `${idPrefix}-filter-${field.key}`;
        return (
          <div key={field.key} className="flex flex-col gap-1 text-xs text-gray-500">
            <label htmlFor={id}>{field.label}</label>
            {field.type === 'select' ? (
              <select
                id={id}
                className={common}
                value={value}
                onChange={(e) => setFilter(field.key, e.target.value)}
                data-testid={`filter-${field.key}`}
              >
                <option value="">All</option>
                {field.options.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            ) : (
              <input
                id={id}
                type={field.type || 'text'}
                className={common}
                placeholder={field.placeholder || ''}
                value={value}
                onChange={(e) => setFilter(field.key, e.target.value)}
                data-testid={`filter-${field.key}`}
              />
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={onReset}
        className="text-sm rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium shadow-sm hover:bg-gray-50"
        data-testid="filter-reset"
  const activeFilters = fields
    .map((field) => ({ field, value: getFilter(field.key) }))
    .filter(({ value }) => value);

  // A date *range* is the first two date-typed fields (the from/to pair every
  // list page declares in that order). A bar with fewer shows no presets.
  const dateFields = fields.filter((field) => field.type === 'date');
  const dateRange = dateFields.length >= 2 ? [dateFields[0], dateFields[1]] : null;
  const applyPreset = (preset) => {
    const [start, end] = preset.range(new Date());
    // Two functional updates compose; useListQuery's setFilter also clears the
    // cursor window, so the page re-queries immediately with the new bounds.
    setFilter(dateRange[0].key, isoDay(start));
    setFilter(dateRange[1].key, isoDay(end));
  };
  const presetIsActive = (preset) => {
    const [start, end] = preset.range(new Date());
    return (
      getFilter(dateRange[0].key) === isoDay(start) && getFilter(dateRange[1].key) === isoDay(end)
    );
  };

  return (
    <div className="mb-4">
      {dateRange && (
        <div
          className="mb-2 flex flex-wrap items-center gap-2"
          role="group"
          aria-label="Quick date ranges"
        >
          {DATE_PRESETS.map((preset) => {
            const active = presetIsActive(preset);
            return (
              <button
                key={preset.label}
                type="button"
                onClick={() => applyPreset(preset)}
                aria-pressed={active}
                className={`rounded-full border px-3 py-1 text-xs font-medium shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/40 ${
                  active
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-slate-700'
                }`}
                data-testid={presetTestId(preset.label)}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      )}
      <form
        role="search"
        aria-label="Filter controls"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => e.preventDefault()}
      >
        {fields.map((field) => {
          const value = getFilter(field.key);
          const common = 'text-sm rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-gray-900 dark:text-gray-100 px-3 py-1.5 shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/40';
          const id = `${idPrefix}-filter-${field.key}`;
          return (
            <div key={field.key} className="flex flex-col gap-1 text-xs text-gray-500 dark:text-gray-400">
              <label htmlFor={id}>{field.label}</label>
              {field.type === 'select' ? (
                <select
                  id={id}
                  className={common}
                  value={value}
                  onChange={(e) => setFilter(field.key, e.target.value)}
                  data-testid={`filter-${field.key}`}
                >
                  <option value="">All</option>
                  {field.options.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              ) : (
                <FilterInput field={field} id={id} value={value} setFilter={setFilter} />
              )}
            </div>
          );
        })}
        <button
          type="button"
          onClick={onReset}
          className="text-sm rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-700 dark:text-gray-200 px-3 py-1.5 font-medium shadow-sm hover:bg-gray-50 dark:hover:bg-slate-700"
          data-testid="filter-reset"
        >
          Reset
        </button>
      </form>
      {activeFilters.length > 0 && (
        <ul className="flex flex-wrap items-center gap-2 mt-3" aria-label="Active filters">
          {activeFilters.map(({ field, value }) => (
            <li
              key={field.key}
              className="inline-flex items-center gap-1 rounded-full bg-gray-100 dark:bg-slate-800 pl-3 pr-1 py-1 text-xs text-gray-700 dark:text-gray-300"
            >
              <span>{field.label}: {value}</span>
              <button
                type="button"
                onClick={() => setFilter(field.key, '')}
                aria-label={`Clear ${field.label} filter`}
                className="rounded-full px-1.5 leading-none hover:bg-gray-200 dark:hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/40"
                data-testid={`filter-chip-clear-${field.key}`}
              >
                &times;
              </button>
            </li>
          ))}
          {activeFilters.length >= 2 && (
            <li>
              <button
                type="button"
                onClick={onReset}
                className="text-xs font-medium text-gray-600 dark:text-gray-400 underline hover:text-gray-900 dark:hover:text-gray-100"
                data-testid="filter-clear-all"
              >
                Clear All
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
