import { ChevronLeft, ChevronRight } from 'lucide-react';

// Cursor pager for the admin tables. `pagination` is the block returned by the
// API ({ hasMore, prevCursor, nextCursor }). We never know the absolute page
// count with keyset pagination, so we expose Prev/Next driven by the cursors.
export default function Pagination({ pagination, onNext, onPrev }) {
  if (!pagination) return null;

  const { hasMore, prevCursor, nextCursor } = pagination;
  const canPrev = Boolean(prevCursor);
  const canNext = Boolean(nextCursor) && hasMore;
  const showButtons = canPrev || canNext;

  return (
    <div className="flex items-center justify-between gap-3 mt-4 text-sm text-gray-600">
      <span>
        {pagination.total != null ? `Total: ${pagination.total}` : 'Showing latest results'}
      </span>
      {showButtons && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onPrev?.(prevCursor)}
            disabled={!canPrev}
            className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium shadow-sm transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft size={16} aria-hidden="true" /> Prev
          </button>
          <button
            type="button"
            onClick={() => onNext?.(nextCursor)}
            disabled={!canNext}
            className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium shadow-sm transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
