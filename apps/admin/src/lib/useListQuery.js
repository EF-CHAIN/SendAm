import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

// Bridges an admin list page's cursor + filters to the URL so filter state and
// pagination survive reloads and browser navigation. The API reads `after`,
// `before`, `limit` and the filter keys straight from the query string.
export function useListQuery(filterKeys = []) {
  const [searchParams, setSearchParams] = useSearchParams();

  // Stable across renders so the fetch effect doesn't loop: identity only
  // changes when the serialised query string changes.
  const params = useMemo(() => {
    const entries = Object.fromEntries(searchParams.entries());
    const result = {};
    for (const key of ['after', 'before', 'limit', ...filterKeys]) {
      if (entries[key]) result[key] = entries[key];
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.toString()]);

  const entries = Object.fromEntries(searchParams.entries());

  const setParam = (key, value) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value == null || value === '') next.delete(key);
      else next.set(key, value);
      return next;
    });
  };

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
