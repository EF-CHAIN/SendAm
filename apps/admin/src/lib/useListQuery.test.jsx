import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter, createSearchParams } from 'react-router-dom';
import { useListQuery } from './useListQuery';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useSearchParams: vi.fn(),
  };
});

import { useSearchParams } from 'react-router-dom';

function wrapper({ children, initialEntries = ['/'] }) {
  return (
    <MemoryRouter initialEntries={initialEntries}>
      {children}
    </MemoryRouter>
  );
}

let setSearchParamsMock;
let capturedSearchParams;

function setupSearchParams(params = {}) {
  capturedSearchParams = createSearchParams(params);
  setSearchParamsMock = vi.fn((updater) => {
    if (typeof updater === 'function') {
      const next = new URLSearchParams(capturedSearchParams);
      return updater(next);
    }
    return new URLSearchParams(updater);
  });
  useSearchParams.mockReturnValue([capturedSearchParams, setSearchParamsMock]);
  return { searchParams: capturedSearchParams, setSearchParams: setSearchParamsMock };
}

describe('useListQuery hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSearchParamsMock = undefined;
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('returns params with cursor and limit from URL', () => {
    setupSearchParams({ after: 'cursor123', limit: '20' });

    const { result } = renderHook(() => useListQuery(), { wrapper });

    expect(result.current.params).toEqual({ after: 'cursor123', limit: '20' });
  });

  it('returns params with filter keys from URL', () => {
    setupSearchParams({ status: 'active', type: 'payment', after: 'cursor123' });

    const { result } = renderHook(() => useListQuery(['status', 'type']), { wrapper });

    expect(result.current.params).toEqual({
      after: 'cursor123',
      status: 'active',
      type: 'payment',
    });
  });

  it('excludes empty filter values from params', () => {
    setupSearchParams({ status: '', type: 'payment' });

    const { result } = renderHook(() => useListQuery(['status', 'type']), { wrapper });

    expect(result.current.params).toEqual({ type: 'payment' });
  });

  it('excludes before cursor when not present', () => {
    setupSearchParams({ before: 'cursor456' });

    const { result } = renderHook(() => useListQuery(), { wrapper });

    expect(result.current.params).toEqual({ before: 'cursor456' });
  });

  it('getFilter returns value for existing key', () => {
    setupSearchParams({ status: 'active' });

    const { result } = renderHook(() => useListQuery(['status']), { wrapper });

    expect(result.current.getFilter('status')).toBe('active');
  });

  it('getFilter returns empty string for missing key', () => {
    setupSearchParams({});

    const { result } = renderHook(() => useListQuery(['status']), { wrapper });

    expect(result.current.getFilter('status')).toBe('');
  });

  it('setFilter adds new filter and clears cursors', () => {
    setupSearchParams({ after: 'cursor123', before: 'cursor456' });

    const { result } = renderHook(() => useListQuery(['status']), { wrapper });

    act(() => {
      result.current.setFilter('status', 'active');
    });

    expect(setSearchParamsMock).toHaveBeenCalled();
    const nextParams = setSearchParamsMock.mock.results[0].value;
    expect(nextParams.get('status')).toBe('active');
    expect(nextParams.has('after')).toBe(false);
    expect(nextParams.has('before')).toBe(false);
  });

  it('setFilter removes filter when value is falsy', () => {
    setupSearchParams({ status: 'active', after: 'cursor123' });

    const { result } = renderHook(() => useListQuery(['status']), { wrapper });

    act(() => {
      result.current.setFilter('status', '');
    });

    expect(setSearchParamsMock).toHaveBeenCalled();
    const nextParams = setSearchParamsMock.mock.results[0].value;
    expect(nextParams.has('status')).toBe(false);
    expect(nextParams.has('after')).toBe(false);
  });

  it('goNext sets after cursor and clears before', () => {
    setupSearchParams({ before: 'cursor456' });

    const { result } = renderHook(() => useListQuery(), { wrapper });

    act(() => {
      result.current.goNext('next-cursor');
    });

    expect(setSearchParamsMock).toHaveBeenCalled();
    const nextParams = setSearchParamsMock.mock.results[0].value;
    expect(nextParams.get('after')).toBe('next-cursor');
    expect(nextParams.has('before')).toBe(false);
  });

  it('goPrev sets before cursor and clears after', () => {
    setupSearchParams({ after: 'cursor123' });

    const { result } = renderHook(() => useListQuery(), { wrapper });

    act(() => {
      result.current.goPrev('prev-cursor');
    });

    expect(setSearchParamsMock).toHaveBeenCalled();
    const nextParams = setSearchParamsMock.mock.results[0].value;
    expect(nextParams.get('before')).toBe('prev-cursor');
    expect(nextParams.has('after')).toBe(false);
  });

  it('resetFilters removes all filter keys and cursors', () => {
    setupSearchParams({
      status: 'active',
      type: 'payment',
      after: 'cursor123',
      before: 'cursor456',
    });

    const { result } = renderHook(() => useListQuery(['status', 'type']), { wrapper });

    act(() => {
      result.current.resetFilters();
    });

    expect(setSearchParamsMock).toHaveBeenCalled();
    const nextParams = setSearchParamsMock.mock.results[0].value;
    expect(nextParams.has('status')).toBe(false);
    expect(nextParams.has('type')).toBe(false);
    expect(nextParams.has('after')).toBe(false);
    expect(nextParams.has('before')).toBe(false);
  });

  it('returns stable params reference when query string unchanged', () => {
    setupSearchParams({ after: 'cursor123' });

    const { result, rerender } = renderHook(() => useListQuery(), { wrapper });

    const firstParams = result.current.params;
    rerender();
    const secondParams = result.current.params;

    expect(firstParams).toBe(secondParams);
  });

  it('returns new params reference when query string changes', () => {
    const { result, rerender } = renderHook(
      ({ initialParams }) => {
        setupSearchParams(initialParams);
        return useListQuery();
      },
      { wrapper, initialProps: { initialParams: { after: 'cursor1' } } }
    );

    const firstParams = result.current.params;
    rerender({ initialParams: { after: 'cursor2' } });
    const secondParams = result.current.params;

    expect(firstParams).not.toBe(secondParams);
  });
});