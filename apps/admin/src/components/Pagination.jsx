import { useEffect, useId, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';

const PAGE_SIZES = [10, 25, 50, 100];

// Cursor pager for the admin tables. `pagination` is the block returned by the
// API ({ hasMore, prevCursor, nextCursor, total }). Keyset pagination never
// returns an absolute page count from the cursor alone, but the API does return
// `total`, so together with the page size we can bound a jump target to
// 1..totalPages and let the operator type a destination instead of clicking
// Next dozens of times (#753).
//
// A jump cannot resolve in a single request: cursors only step one page at a
// time. Entering a target therefore starts an automatic walk — one fetched page
// per step — that stops as soon as the target page is reached (or the cursor
// window runs out). The walk's bookkeeping (deciding the next step, clearing a
// finished walk) is derived during render, and the effect below only performs
// the navigation itself. Its deps are the primitive step decision plus the two
// cursor strings, which doubles as the freshness gate: a stale response keeps
// the same cursor values, so it can never re-fire a step the pager already
// took, while genuinely new data always carries new cursor strings.
export default function Pagination({ pagination, onNext, onPrev }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const idPrefix = useId();
  const currentPage = Math.max(1, Number(searchParams.get('page')) || 1);
  const [draftPage, setDraftPage] = useState(String(currentPage));
  // Human-readable reason the input is flagged, or '' when the last jump was
  // clean. Cleared as soon as the operator edits the field again.
  const [jumpError, setJumpError] = useState('');
  const [jumpTarget, setJumpTarget] = useState(null);
  // The last page number reflected into the input; the render-phase
  // adjustment below mirrors navigation into the field without an effect.
  const [shownPage, setShownPage] = useState(currentPage);
  // Latest navigation callbacks. Parent pages recreate them every render;
  // reading them through this ref keeps the step effect's dependencies down to
  // the primitives above so an unrelated re-render cannot re-fire a step.
  const navRef = useRef(null);

  const { hasMore, prevCursor, nextCursor, total } = pagination || {};
  const canPrev = Boolean(prevCursor);
  const canNext = Boolean(nextCursor) && hasMore;
  const showButtons = canPrev || canNext;
  const requestedLimit = Number(searchParams.get('limit'));
  const pageSize = PAGE_SIZES.includes(requestedLimit)
    ? requestedLimit
    : Number(pagination?.limit) || 50;
  const totalPages = total != null && pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : null;

  // Keep the input showing the real current page whenever navigation moves it
  // (manual Prev/Next, or each step of an in-flight jump walk).
  if (shownPage !== currentPage) {
    setShownPage(currentPage);
    setDraftPage(String(currentPage));
  }

  // Decide the next walk step — pure computation from this render's values.
  let walkStep = null;
  if (jumpTarget != null) {
    if (jumpTarget === currentPage) {
      walkStep = 'arrived';
    } else if (jumpTarget > currentPage && canNext) {
      walkStep = 'next';
    } else if (jumpTarget < currentPage && canPrev) {
      walkStep = 'prev';
    } else {
      // The cursor window ran out before the target: stop where we are and
      // flag the input so the operator sees the real destination.
      walkStep = 'stuck';
    }
  }
  if (walkStep === 'arrived') {
    setJumpTarget(null);
  } else if (walkStep === 'stuck') {
    setJumpTarget(null);
    setJumpError(`No further pages — stopped at page ${currentPage}.`);
  }

  // Refresh the latest-callback ref after every commit, before the step effect
  // below runs (effects fire in declaration order).
  useEffect(() => {
    navRef.current = { onNext, onPrev };
  });

  // Navigation side effect for the decided step. It never sets state itself:
  // the URL change re-renders the pager, which re-derives the next step.
  useEffect(() => {
    if (walkStep === 'next') navRef.current?.onNext?.(nextCursor);
    else if (walkStep === 'prev') navRef.current?.onPrev?.(prevCursor);
  }, [walkStep, nextCursor, prevCursor]);

  if (!pagination) return null;

  const changePageSize = (event) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set('limit', event.target.value);
      next.delete('after');
      next.delete('before');
      next.delete('page');
      return next;
    });
  };

  const handleJumpSubmit = (event) => {
    event.preventDefault();
    if (!totalPages) return;
    const parsed = Number.parseInt(draftPage, 10);
    if (Number.isNaN(parsed)) {
      setJumpError('Enter a valid page number.');
      setDraftPage(String(currentPage));
      return;
    }
    // Boundary clamping: anything outside 1..totalPages lands on the nearest
    // legal page and flags the input with a visual error state (#753 AC).
    const clamped = Math.min(Math.max(parsed, 1), totalPages);
    setJumpError(clamped !== parsed ? `Page out of range — clamped to 1–${totalPages}.` : '');
    setDraftPage(String(clamped));
    if (clamped !== currentPage) setJumpTarget(clamped);
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
      {totalPages != null && (
        // noValidate: out-of-range values are exactly what this form must
        // accept — native constraint validation would block the submit and
        // the clamping inside handleJumpSubmit could never run.
        <form noValidate onSubmit={handleJumpSubmit} className="inline-flex items-center gap-2">
          <label htmlFor={`${idPrefix}-jump-page`} className="inline-flex items-center gap-2">
            <span>Go to page</span>
            <input
              id={`${idPrefix}-jump-page`}
              type="number"
              min={1}
              max={totalPages}
              inputMode="numeric"
              value={draftPage}
              onChange={(event) => {
                setDraftPage(event.target.value);
                setJumpError('');
              }}
              aria-invalid={jumpError ? true : undefined}
              aria-describedby={jumpError ? `${idPrefix}-jump-page-error` : undefined}
              className={`w-20 rounded-lg border px-2 py-1.5 text-sm shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
                jumpError
                  ? 'border-red-500 ring-1 ring-red-500 text-red-700 dark:text-red-400'
                  : 'border-gray-200 bg-white text-gray-700'
              }`}
              data-testid="jump-to-page"
            />
          </label>
          <button
            type="submit"
            className="rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-700 dark:text-gray-200 px-3 py-1.5 font-medium shadow-sm transition-colors hover:bg-gray-50 dark:hover:bg-slate-700"
          >
            Go
          </button>
          {jumpError && (
            <span
              id={`${idPrefix}-jump-page-error`}
              role="alert"
              className="text-xs text-red-600 dark:text-red-400"
            >
              {jumpError}
            </span>
          )}
        </form>
      )}
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
