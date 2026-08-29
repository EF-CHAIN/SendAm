// Reusable filter bar for admin list pages. `fields` is an array of
// { key, label, placeholder?, type?: 'text' | 'select', options?: string[] }.
// Values are read from the URL via `getFilter` and written via `setFilter`,
// which keeps them in sync with the shared list query state.
export default function FilterBar({ fields = [], getFilter, setFilter, onReset, submitLabel = 'Apply' }) {
  return (
    <form
      className="flex flex-wrap items-end gap-3 mb-4"
      onSubmit={(e) => e.preventDefault()}
    >
      {fields.map((field) => {
        const value = getFilter(field.key);
        const common = 'text-sm rounded-lg border border-gray-200 bg-white px-3 py-1.5 shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/40';
        return (
          <label key={field.key} className="flex flex-col gap-1 text-xs text-gray-500">
            {field.label}
            {field.type === 'select' ? (
              <select
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
                type={field.type || 'text'}
                className={common}
                placeholder={field.placeholder || ''}
                value={value}
                onChange={(e) => setFilter(field.key, e.target.value)}
                data-testid={`filter-${field.key}`}
              />
            )}
          </label>
        );
      })}
      <button
        type="button"
        onClick={onReset}
        className="text-sm rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium shadow-sm hover:bg-gray-50"
        data-testid="filter-reset"
      >
        Reset
      </button>
    </form>
  );
}
