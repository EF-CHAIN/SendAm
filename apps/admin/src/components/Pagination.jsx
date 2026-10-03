import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';

const PAGE_SIZES = [10, 25, 50, 100];

// Cursor pager for the admin tables. `pagination` is the block returned by the
// API ({ hasMore, prevCursor, nextCursor }). We never know the absolute page
// count with keyset pagination, so we expose Prev/Next driven by the cursors.
export default function Pagination({ pagination, onNext, onPrev }) {
  const [searchParams, setSearchParams] = useSearchParams();
  if (!pagination) return null;

  const { hasMore, prevCursor, nextCursor } = pagination;
  const canPrev = Boolean(prevCursor);
  const canNext = Boolean(nextCursor) && hasMore;
  const showButtons = canPrev || canNext;
  const requestedLimit = Number(searchParams.get('limit'));
  const pageSize = PAGE_SIZES.includes(requestedLimit) ? requestedLimit : Number(pagination.limit) || 50;

  const changePageSize = (event) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set('limit', event.target.value);
      next.delete('after');
      next.delete('before');
      return next;
    });
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mt-4 text-sm text-gray-600 dark:text-gray-400">
      <span>
        {pagination.total != null ? `Total: ${pagination.total}` : 'Showing latest results'}
      </span>
      <label className="inline-flex items-center gap-2">
        <span>Items per page</span>
        <select
          aria-label="Items per page"
          value={pageSize}
          onChange={changePageSize}
          className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-700 shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
        </select>
      </label>
      {showButtons && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onPrev?.(prevCursor)}
            disabled={!canPrev}
            className="inline-flex items-center gap-1 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-700 dark:text-gray-200 px-3 py-1.5 font-medium shadow-sm transition-colors hover:bg-gray-50 dark:hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft size={16} aria-hidden="true" /> Prev
          </button>
          <button
            type="button"
            onClick={() => onNext?.(nextCursor)}
            disabled={!canNext}
            className="inline-flex items-center gap-1 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-700 dark:text-gray-200 px-3 py-1.5 font-medium shadow-sm transition-colors hover:bg-gray-50 dark:hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
