import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

// Bridges an admin list page's cursor + filters to the URL so filter state and
// pagination survive reloads and browser navigation. The API reads `after`,
// `before`, `limit` and the filter keys straight from the query string.
//
// `page` (1-based, default 1) is tracked alongside the cursors so the operator's
// position is part of the shareable URL — the cursors alone cannot tell you
// which page you are on, and the jump-to-page control (#753) reads it.
export function useListQuery(filterKeys = []) {
  const [searchParams, setSearchParams] = useSearchParams();

  // Capture the serialised query string as a primitive so the dependency array
  // only contains a simple expression (required by react-hooks/exhaustive-deps).
  const searchString = searchParams.toString();

  // Stable across renders so the fetch effect doesn't loop: identity only
  // changes when the serialised query string changes.
  const queryString = searchParams.toString();
  const params = useMemo(() => {
    const entries = Object.fromEntries(new URLSearchParams(searchString).entries());
    const result = {};
    for (const key of ['after', 'before', 'limit', ...filterKeys]) {
      if (entries[key]) result[key] = entries[key];
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryString]);

  const entries = Object.fromEntries(searchParams.entries());
  // The API never receives `page` — cursors do the paging — but every shared
  // link restores the operator to the page they copied.
  const page = Math.max(1, Number(entries.page) || 1);

  const setFilter = (key, value) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value);
      else next.delete(key);
      // Any filter change invalidates the current cursor window.
      next.delete('after');
      next.delete('before');
      next.delete('page');
      return next;
    });
  };

  const goNext = (cursor) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('after', cursor);
      next.delete('before');
      const current = Math.max(1, Number(next.get('page')) || 1);
      next.set('page', String(current + 1));
      return next;
    });
  };
  const goPrev = (cursor) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('before', cursor);
      next.delete('after');
      const current = Math.max(1, Number(next.get('page')) || 1);
      // Page 1 is the canonical default; keep the URL clean instead of `page=1`.
      if (current > 2) next.set('page', String(current - 1));
      else next.delete('page');
      return next;
    });
  };
  const resetFilters = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const key of filterKeys) next.delete(key);
      next.delete('after');
      next.delete('before');
      next.delete('page');
      return next;
    });
  };

  return {
    params,
    page,
    getFilter: (key) => entries[key] || '',
    setFilter,
    resetFilters,
    goNext,
    goPrev,
  };
}
