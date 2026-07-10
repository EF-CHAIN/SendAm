import { ChevronLeft, ChevronRight } from 'lucide-react';

// Simple Prev/Next pager for the admin tables. Hidden when everything fits on
// one page. `pagination` is the block returned by the API ({ page, totalPages,
// total, limit }).
export default function Pagination({ pagination, onPageChange }) {
  if (!pagination) return null;

  const { page, totalPages, total, limit } = pagination;
  if (totalPages <= 1) return null;

  const from = (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);

  return (
    <div className="flex items-center justify-between gap-3 mt-4 text-sm text-gray-600">
      <span>
        Showing {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium shadow-sm transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronLeft size={16} aria-hidden="true" /> Prev
        </button>
        <span className="px-1">
          Page {page} of {totalPages}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium shadow-sm transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
