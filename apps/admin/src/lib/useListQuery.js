import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

// Bridges an admin list page's cursor + filters to the URL so filter state and
// pagination survive reloads and browser navigation. The API reads `after`,
// `before`, `limit` and the filter keys straight from the query string.
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

  const setFilter = (key, value) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value);
      else next.delete(key);
      // Any filter change invalidates the current cursor window.
      next.delete('after');
      next.delete('before');
      return next;
    });
  };

  const setCursors = ({ after, before }) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (after == null) next.delete('after');
      else next.set('after', after);
      if (before == null) next.delete('before');
      else next.set('before', before);
      return next;
    });
  };

  const goNext = (cursor) => setCursors({ after: cursor, before: null });
  const goPrev = (cursor) => setCursors({ after: null, before: cursor });
  const resetFilters = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const key of filterKeys) next.delete(key);
      next.delete('after');
      next.delete('before');
      return next;
    });
  };

  return {
    params,
    getFilter: (key) => entries[key] || '',
    setFilter,
    resetFilters,
    goNext,
    goPrev,
  };
}
