import { SearchX, FilterX } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';

/**
 * Generic data table with optional row-click support.
 *
 * Props:
 *   columns        — array of { header, accessor?, render? }
 *   data           — array of row objects
 *   keyField       — unique key field name (default: 'id')
 *   onRowClick     — optional (row) => void handler; makes rows focusable / clickable
 *   rowClassName   — optional extra class(es) added to every <tr>
 *   emptyState     — optional { title, description, icon } overriding the default
 *                    copy/icon used when a query yields no rows
 *   filtersActive  — optional boolean; when omitted it is derived from the URL
 *                    (any query param besides the pagination cursors counts as a filter)
 *   onResetFilters — optional callback for the empty-state "Reset Filters" button;
 *                    defaults to clearing the filter params from the URL
 */

// Pagination cursors and page size are not filters — they must not trigger the
// "Reset Filters" recovery action in the empty state.
const NON_FILTER_PARAMS = new Set(['after', 'before', 'limit']);

export default function DataTable({
  columns,
  data,
  keyField = 'id',
  onRowClick,
  rowClassName = '',
  emptyState,
  filtersActive,
  onResetFilters,
}) {
  // Hooks run before the empty-table early return so the rules of hooks hold.
  // Reading the URL here means every list page gets the recovery action without
  // extra wiring at the call site.
  const [searchParams, setSearchParams] = useSearchParams();
  const hasActiveFilters =
    filtersActive ??
    Array.from(searchParams.keys()).some((key) => !NON_FILTER_PARAMS.has(key));

  if (!data || data.length === 0) {
    const {
      title = 'No records found.',
      description = hasActiveFilters
        ? 'No records match your current search or filters. Reset them to see the full list again.'
        : 'There are no records to show right now. New records will appear here as soon as they exist.',
      icon: Icon = hasActiveFilters ? FilterX : SearchX,
    } = emptyState || {};

    const handleReset = () => {
      if (onResetFilters) {
        onResetFilters();
        return;
      }
      // Clear every filter and the stale cursor window, but keep the page size.
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        for (const key of Array.from(next.keys())) {
          if (key !== 'limit') next.delete(key);
        }
        return next;
      });
    };

    return (
      <div
        role="status"
        className="bg-white rounded-xl border border-gray-100 shadow-sm px-6 py-14 sm:py-16 text-center"
      >
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-secondary text-primary">
          <Icon className="w-6 h-6" aria-hidden="true" />
        </div>
        <p className="mt-4 text-base sm:text-lg font-semibold text-dark">{title}</p>
        <p className="mt-2 mx-auto max-w-md text-sm leading-6 text-gray-500">{description}</p>
        {hasActiveFilters && (
          <button
            type="button"
            onClick={handleReset}
            data-testid="empty-reset-filters"
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <FilterX size={16} aria-hidden="true" />
            Reset Filters
          </button>
        )}
      </div>
    );
  }

  const handleRowKeyDown = (e, row) => {
    if (onRowClick && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onRowClick(row);
    }
  };

  return (
    <div className="w-full max-w-full overflow-x-auto bg-white rounded-xl border border-gray-100 shadow-sm">
      <table className="min-w-max w-full text-sm text-left text-gray-600">
        <thead className="text-xs text-gray-500 uppercase bg-gray-50 border-b border-gray-100">
          <tr>
            {columns.map((col, idx) => (
              <th key={idx} scope="col" className="px-4 sm:px-6 py-4 whitespace-nowrap">
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, idx) => (
            <tr
              key={row[keyField] || idx}
              className={`border-b border-gray-50 hover:bg-gray-50/50 transition-colors ${rowClassName}`}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onRowClick ? (e) => handleRowKeyDown(e, row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              aria-label={onRowClick ? `View details for row ${idx + 1}` : undefined}
            >
              {columns.map((col, colIdx) => (
                <td key={colIdx} className="px-4 sm:px-6 py-4 whitespace-nowrap">
                  {col.render ? col.render(row) : row[col.accessor]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
