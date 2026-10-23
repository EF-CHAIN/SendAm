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

  // Only the cursor, page size and filter keys reach the API. Keying the memo
  // on just those keeps `params` stable when unrelated URL state changes (for
  // example the DataTable's `sort`/`dir`), so the fetch effect does not refetch.
  const apiKeys = ['after', 'before', 'limit', ...filterKeys];
  const apiQuery = apiKeys
    .filter((key) => searchParams.get(key))
    .map((key) => `${key}=${encodeURIComponent(searchParams.get(key))}`)
    .join('&');
  const params = useMemo(() => {
    const result = {};
    for (const pair of apiQuery ? apiQuery.split('&') : []) {
      const [key, value] = pair.split('=');
      result[key] = decodeURIComponent(value);
    }
    return result;
  }, [apiQuery]);

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
