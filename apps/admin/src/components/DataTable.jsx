import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import {
  SearchX,
  FilterX,
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Columns3,
  ChevronUp,
  ChevronDown,
  RotateCcw,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { compareValues, sortFromSearchParams, DIRECTION_TO_DIR } from './dataTableSort';

const FOCUSABLE_HEADER = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

// Pagination cursors and page size are not filters — they must not trigger the
// "Reset Filters" recovery action in the empty state.
const NON_FILTER_PARAMS = new Set(['after', 'before', 'limit', 'sort', 'dir']);

// Single-line content + vertical padding + the row's 1px border. An explicit
// rowHeight remains the Default density's minimum; the other modes track it.
const DENSITIES = {
  compact: { label: 'Compact', className: 'py-1 text-xs', height: 25 },
  default: { label: 'Default', className: 'py-3 text-sm', height: 45 },
  comfortable: { label: 'Comfortable', className: 'py-5 text-base', height: 65 },
};

// Sort state is an ordered list of { key, direction }: the first entry is the
// primary sort and each later entry only breaks ties left by the ones before it.
function normalizeSort(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

const flipDirection = (direction) => (direction === 'ascending' ? 'descending' : 'ascending');

function sortRows(data, columns, sortList) {
  if (!data) return [];
  const active = sortList.filter((entry) =>
    columns.some((c) => c.sortable && (c.accessor ?? c.header) === entry.key)
  );
  if (active.length === 0) return data;

  return [...data].sort((a, b) => {
    for (const { key, direction } of active) {
      const factor = direction === 'descending' ? -1 : 1;
      const result = factor * compareValues(a[key], b[key]);
      if (result !== 0) return result;
    }
    return 0;
  });
}

// Stable identity for a column, matching the sort key convention.
const columnId = (column) => column.accessor ?? column.header;

// Column preferences are stored as an ordered list of ids plus the ids that
// are hidden, so both the order and the visibility survive a reload.
function readColumnPrefs(storageId) {
  if (typeof window === 'undefined' || !storageId) return null;
  try {
    const raw = window.localStorage.getItem(storageId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.order) || !Array.isArray(parsed.hidden)) return null;
    return { order: parsed.order, hidden: parsed.hidden };
  } catch {
    return null;
  }
}

// Drops ids for columns that no longer exist and appends newly added columns.
function reconcileColumnPrefs(current, columns) {
  const known = columns.map(columnId);
  const order = [
    ...current.order.filter((id) => known.includes(id)),
    ...known.filter((id) => !current.order.includes(id)),
  ];
  const hidden = current.hidden.filter((id) => known.includes(id));

  const orderSame =
    order.length === current.order.length && order.every((id, i) => id === current.order[i]);
  const hiddenSame =
    hidden.length === current.hidden.length && hidden.every((id, i) => id === current.hidden[i]);
  if (orderSame && hiddenSame) return current;
  return { order, hidden };
}

export default function DataTable({
  columns,
  data,
  caption,
  keyField = 'id',
  onRowClick,
  rowClassName = '',
  defaultSort = null,
  emptyState,
  filtersActive,
  onResetFilters,
  rowHeight = 45,
  maxHeight = 600,
  overscan = 5,
  virtualizeThreshold = 50,
  syncSortWithUrl = false,
  storageKey,
}) {
  const [localSort, setLocalSort] = useState(() => normalizeSort(defaultSort));

  // Column visibility/order preferences, scoped to this table by storageKey or
  // the caption so different tables do not share a saved layout.
  const storageId = storageKey || `datatable:columns:${caption || 'default'}`;
  const [storedPrefs, setColumnPrefs] = useState(() => {
    const stored = readColumnPrefs(storageId);
    if (!stored) return { order: columns.map(columnId), hidden: [] };
    return reconcileColumnPrefs(stored, columns);
  });
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const customizeRef = useRef(null);

  const [density, setDensity] = useState('default');
  const [measuredHeights, setMeasuredHeights] = useState({});
  const densityConfig = DENSITIES[density];
  const effectiveRowHeight = Math.max(
    densityConfig.height,
    rowHeight + densityConfig.height - DENSITIES.default.height,
    measuredHeights[density] || 0
  );
  const [searchParams, setSearchParams] = useSearchParams();
  // With URL sync the query string is the single source of truth, so a sorted
  // view survives reloads, shared links and back/forward navigation. Unknown
  // keys or directions fall back to `defaultSort`.
  const sort = syncSortWithUrl
    ? normalizeSort(sortFromSearchParams(searchParams, columns) ?? defaultSort)
    : localSort;
  const hasActiveFilters =
    filtersActive ??
    Array.from(searchParams.keys()).some((key) => !NON_FILTER_PARAMS.has(key));

  const sortKeyOf = (column) => column.accessor ?? column.header;
  const sortedData = useMemo(() => sortRows(data, columns, sort), [data, columns, sort]);

  // Plain click: sort by this column alone, flipping direction if it already
  // leads the sort. Shift+click: add it as a secondary key, or flip its direction
  // when it is already part of the sort. Plain clicks clear any secondary keys.
  // With URL sync the sort is a single key kept in the query string, so
  // shift+click behaves like a plain click there.
  const handleSort = (column, event) => {
    const key = sortKeyOf(column);

    if (syncSortWithUrl) {
      const primary = sort[0];
      const next =
        primary?.key === key
          ? { key, direction: flipDirection(primary.direction) }
          : { key, direction: 'ascending' };
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set('sort', next.key);
          params.set('dir', DIRECTION_TO_DIR[next.direction]);
          return params;
        },
        { replace: true }
      );
      return;
    }

    setLocalSort((current) => {
      const existing = current.findIndex((entry) => entry.key === key);
      if (event?.shiftKey) {
        if (existing === -1) return [...current, { key, direction: 'ascending' }];
        return current.map((entry, index) =>
          index === existing ? { key, direction: flipDirection(entry.direction) } : entry
        );
      }
      if (current[0]?.key === key) {
        return [{ key, direction: flipDirection(current[0].direction) }];
      }
      return [{ key, direction: 'ascending' }];
    });
  };

  const ariaSortFor = (column) => {
    if (!column.sortable) return undefined;
    const entry = sort.find((item) => item.key === sortKeyOf(column));
    if (!entry) return 'none';
    return entry.direction === 'descending' ? 'descending' : 'ascending';
  };

  const containerRef = useRef(null);
  const headerRef = useRef(null);
  const rowRefs = useRef(new Map());
  const pendingFocusRef = useRef(null);
  // Preserve the reading position, or the bottom edge when reviewing the last
  // rows. Bottom affinity survives the first ResizeObserver correction in a
  // density that has not been measured yet.
  const [scrollAnchor, setScrollAnchor] = useState({ offset: 0, atEnd: false });
  const [headerHeight, setHeaderHeight] = useState(49);
  const [containerHeight, setContainerHeight] = useState(
    typeof maxHeight === 'number' ? maxHeight : 600
  );
  const [focusedIndex, setFocusedIndex] = useState(null);

  // Reconcile on read so columns added or removed by the parent show up
  // without an effect-driven state update.
  const columnPrefs = useMemo(
    () => reconcileColumnPrefs(storedPrefs, columns),
    [storedPrefs, columns]
  );

  // Persist preferences so the layout is restored on the next visit.
  useEffect(() => {
    if (typeof window === 'undefined' || !storageId) return;
    try {
      window.localStorage.setItem(storageId, JSON.stringify(columnPrefs));
    } catch {
      // Ignore storage quota or privacy-mode failures.
    }
  }, [storageId, columnPrefs]);

  // Close the customize popover on outside click or Escape.
  useEffect(() => {
    if (!customizeOpen) return undefined;

    const handlePointerDown = (event) => {
      if (customizeRef.current && !customizeRef.current.contains(event.target)) {
        setCustomizeOpen(false);
      }
    };
    const handleEscape = (event) => {
      if (event.key === 'Escape') setCustomizeOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [customizeOpen]);

  const totalRows = sortedData ? sortedData.length : 0;
  const isVirtualized = totalRows >= virtualizeThreshold;
  const hasRows = totalRows > 0;
  const maxScrollTop = Math.max(0, headerHeight + totalRows * effectiveRowHeight - containerHeight);
  const scrollTop = scrollAnchor.atEnd
    ? maxScrollTop
    : Math.min(scrollAnchor.offset * effectiveRowHeight, maxScrollTop);

  useEffect(() => {
    const el = containerRef.current;
    const header = headerRef.current;
    if (!el || !header || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === el && entry.contentRect.height > 0) {
          setContainerHeight(entry.contentRect.height);
        } else if (entry.target === header) {
          const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
          if (height > 0) setHeaderHeight(height);
        }
      }
    });
    observer.observe(el);
    observer.observe(header);
    return () => observer.disconnect();
  }, [hasRows]);

  // Write once after React has updated the row heights and spacers, before paint.
  // Writing in the click handler would clamp against the old scrollable height.
  useLayoutEffect(() => {
    if (isVirtualized && containerRef.current) {
      containerRef.current.scrollTop = scrollTop;
    }
  }, [isVirtualized, scrollTop]);

  const handleScroll = useCallback((e) => {
    const top = e.currentTarget.scrollTop;
    setScrollAnchor({
      offset: top / effectiveRowHeight,
      atEnd: maxScrollTop > 0 && top >= maxScrollTop - 1,
    });
  }, [effectiveRowHeight, maxScrollTop]);

  const { startIndex, topPadding, bottomPadding, visibleRows } = useMemo(() => {
    if (!isVirtualized || totalRows === 0) {
      return {
        startIndex: 0,
        endIndex: totalRows - 1,
        topPadding: 0,
        bottomPadding: 0,
        visibleRows: sortedData || [],
      };
    }

    const calculatedStart = Math.min(totalRows - 1, Math.max(0, Math.floor(scrollTop / effectiveRowHeight) - overscan));
    const visibleCount = Math.ceil(containerHeight / effectiveRowHeight);
    const calculatedEnd = Math.min(totalRows - 1, calculatedStart + visibleCount + overscan * 2);

    const start = Math.max(0, calculatedStart);
    const end = Math.min(totalRows - 1, calculatedEnd);

    const topPad = start * effectiveRowHeight;
    const bottomPad = Math.max(0, (totalRows - 1 - end) * effectiveRowHeight);
    const sliced = sortedData.slice(start, end + 1);

    return {
      startIndex: start,
      endIndex: end,
      topPadding: topPad,
      bottomPadding: bottomPad,
      visibleRows: sliced,
    };
  }, [isVirtualized, totalRows, scrollTop, effectiveRowHeight, overscan, containerHeight, sortedData]);

  useEffect(() => {
    if (!isVirtualized || typeof ResizeObserver === 'undefined') return;
    // Custom cells (badges, buttons, etc.) can be taller than plain text. Observe
    // actual row sizes in a batch instead of forcing layout reads on every row.
    const observer = new ResizeObserver((entries) => {
      const height = Math.ceil(Math.max(0, ...entries.map((entry) =>
        entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height
      )));
      setMeasuredHeights((current) => height > (current[density] || 0)
        ? { ...current, [density]: height }
        : current);
    });
    rowRefs.current.forEach((row) => observer.observe(row));
    return () => observer.disconnect();
  }, [density, isVirtualized, visibleRows]);

  const columnsById = useMemo(() => new Map(columns.map((c) => [columnId(c), c])), [columns]);

  const visibleColumns = useMemo(
    () =>
      columnPrefs.order
        .filter((id) => !columnPrefs.hidden.includes(id))
        .map((id) => columnsById.get(id))
        .filter(Boolean),
    [columnPrefs, columnsById]
  );

  const toggleColumn = (id) => {
    setColumnPrefs((current) => {
      if (current.hidden.includes(id)) {
        return { ...current, hidden: current.hidden.filter((cid) => cid !== id) };
      }
      const visibleCount = current.order.filter((cid) => !current.hidden.includes(cid)).length;
      // Keep at least one column visible so the table never collapses.
      if (visibleCount <= 1) return current;
      return { ...current, hidden: [...current.hidden, id] };
    });
  };

  const moveColumn = (id, offset) => {
    setColumnPrefs((current) => {
      const index = current.order.indexOf(id);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= current.order.length) return current;
      const order = [...current.order];
      [order[index], order[target]] = [order[target], order[index]];
      return { ...current, order };
    });
  };

  const resetColumns = () => {
    setColumnPrefs({ order: columns.map(columnId), hidden: [] });
  };

  const scrollRowIntoView = useCallback(
    (targetIndex) => {
      const el = containerRef.current;
      if (!el || targetIndex == null || targetIndex < 0 || targetIndex >= totalRows) return;

      const targetTop = targetIndex * effectiveRowHeight;
      const targetBottom = headerHeight + targetTop + effectiveRowHeight;
      const currentScrollTop = scrollTop;
      const viewHeight = containerHeight;

      let newScrollTop = null;
      if (targetTop < currentScrollTop) {
        newScrollTop = targetTop;
      } else if (targetBottom > currentScrollTop + viewHeight) {
        newScrollTop = targetBottom - viewHeight;
      }

      if (newScrollTop != null) {
        setScrollAnchor({
          offset: newScrollTop / effectiveRowHeight,
          atEnd: maxScrollTop > 0 && newScrollTop >= maxScrollTop - 1,
        });
      }
    },
    [totalRows, effectiveRowHeight, scrollTop, containerHeight, headerHeight, maxScrollTop]
  );

  const focusRow = useCallback(
    (index) => {
      const targetIndex = Math.max(0, Math.min(totalRows - 1, index));
      pendingFocusRef.current = targetIndex;
      setFocusedIndex(targetIndex);
      scrollRowIntoView(targetIndex);
      const domEl = rowRefs.current.get(targetIndex);
      if (domEl) {
        domEl.focus({ preventScroll: isVirtualized });
        pendingFocusRef.current = null;
      }
    },
    [totalRows, scrollRowIntoView, isVirtualized]
  );

  useEffect(() => {
    const targetIndex = pendingFocusRef.current;
    if (targetIndex != null) {
      const domEl = rowRefs.current.get(targetIndex);
      if (domEl) {
        domEl.focus({ preventScroll: isVirtualized });
        pendingFocusRef.current = null;
      }
    }
  }, [focusedIndex, visibleRows, isVirtualized]);

  const handleKeyDown = (e, rowIndex) => {
    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        focusRow(rowIndex + 1);
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        focusRow(rowIndex - 1);
        break;
      }
      case 'Home': {
        e.preventDefault();
        focusRow(0);
        break;
      }
      case 'End': {
        e.preventDefault();
        focusRow(totalRows - 1);
        break;
      }
      case 'Enter':
      case ' ': {
        if (onRowClick) {
          e.preventDefault();
          onRowClick(sortedData[rowIndex]);
        }
        break;
      }
      default:
        break;
    }
  };

  const renderSortButton = (col) => {
    const sortIndex = sort.findIndex((entry) => entry.key === sortKeyOf(col));
    const entry = sortIndex === -1 ? null : sort[sortIndex];
    const showPriority = sort.length > 1 && entry !== null;
    return (
      <button
        type="button"
        onClick={(event) => handleSort(col, event)}
        title="Click to sort. Shift+click to add a secondary sort."
        className={`inline-flex items-center gap-1.5 uppercase font-semibold ${FOCUSABLE_HEADER}`}
      >
        {col.header}
        {entry === null ? (
          <ChevronsUpDown size={14} aria-hidden="true" />
        ) : entry.direction === 'ascending' ? (
          <ArrowUp size={14} aria-hidden="true" />
        ) : (
          <ArrowDown size={14} aria-hidden="true" />
        )}
        {showPriority && (
          <>
            <span
              aria-hidden="true"
              data-testid="sort-priority-badge"
              className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-white"
            >
              {sortIndex + 1}
            </span>
            <span className="sr-only">{`, sort priority ${sortIndex + 1}`}</span>
          </>
        )}
      </button>
    );
  };

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
        role="region"
        aria-label={caption ? `${caption} empty state` : 'Empty table'}
        className="w-full bg-white dark:bg-slate-900 rounded-xl border border-gray-100 dark:border-slate-800 p-8 sm:p-12 text-center shadow-sm"
      >
        <div className="mx-auto w-12 h-12 rounded-full bg-gray-50 dark:bg-slate-800 flex items-center justify-center text-gray-400 dark:text-gray-500 mb-3">
          <Icon className="w-6 h-6" aria-hidden="true" />
        </div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">{title}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 max-w-sm mx-auto mb-4">{description}</p>
        {hasActiveFilters && (
          <button
            type="button"
            onClick={handleReset}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-lg text-primary dark:text-teal-400 bg-secondary dark:bg-teal-950/60 hover:bg-emerald-100 dark:hover:bg-teal-900/60 transition-colors"
          >
            Reset Filters
          </button>
        )}
      </div>
    );
  }

  const containerStyles = isVirtualized
    ? {
        maxHeight: typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight,
        overflowY: 'auto',
        overflowAnchor: 'none',
      }
    : undefined;

  return (
    <div className="w-full min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
        <div
          role="group"
          aria-label={caption ? `${caption} density` : 'Table density'}
          className="inline-flex rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-1 gap-1"
        >
          {Object.entries(DENSITIES).map(([value, option]) => (
            <button
              key={value}
              type="button"
              aria-pressed={density === value}
              onClick={() => setDensity(value)}
              className={`px-2 sm:px-3 py-2 text-xs sm:text-sm font-medium rounded-md transition-colors ${FOCUSABLE_HEADER} ${
                density === value
                  ? 'bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200'
                  : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="relative" ref={customizeRef}>
          <button
            type="button"
            onClick={() => setCustomizeOpen((open) => !open)}
            aria-haspopup="dialog"
            aria-expanded={customizeOpen}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary dark:border-slate-700 dark:text-gray-300 dark:hover:bg-slate-800"
          >
            <Columns3 size={14} aria-hidden="true" />
            Customize Columns
          </button>

          {customizeOpen && (
            <div
              role="dialog"
              aria-label="Customize columns"
              className="absolute right-0 z-30 mt-2 w-64 rounded-xl border border-gray-200 bg-white p-3 text-left shadow-lg dark:border-slate-700 dark:bg-slate-900"
            >
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Columns
              </p>
              <ul className="space-y-1">
                {columnPrefs.order.map((id, index) => {
                  const column = columnsById.get(id);
                  if (!column) return null;
                  const isHidden = columnPrefs.hidden.includes(id);
                  const isLastVisible = !isHidden && visibleColumns.length <= 1;
                  return (
                    <li
                      key={id}
                      className="flex items-center gap-1 rounded-lg px-1.5 py-1 hover:bg-gray-50 dark:hover:bg-slate-800"
                    >
                      <label className="flex flex-1 cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
                        <input
                          type="checkbox"
                          checked={!isHidden}
                          disabled={isLastVisible}
                          onChange={() => toggleColumn(id)}
                          className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary disabled:cursor-not-allowed"
                        />
                        {column.header}
                      </label>
                      <button
                        type="button"
                        onClick={() => moveColumn(id, -1)}
                        disabled={index === 0}
                        aria-label={`Move ${column.header} up`}
                        className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-slate-700"
                      >
                        <ChevronUp size={14} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveColumn(id, 1)}
                        disabled={index === columnPrefs.order.length - 1}
                        aria-label={`Move ${column.header} down`}
                        className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-slate-700"
                      >
                        <ChevronDown size={14} aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
              <button
                type="button"
                onClick={resetColumns}
                className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-slate-800"
              >
                <RotateCcw size={13} aria-hidden="true" />
                Reset columns
              </button>
            </div>
          )}
        </div>
      </div>
      <div
        ref={containerRef}
        onScroll={isVirtualized ? handleScroll : undefined}
        style={containerStyles}
        data-testid="datatable-container"
        data-virtualized={isVirtualized}
        data-virtual-total={totalRows}
        data-virtual-rendered={visibleRows.length}
        data-density={density}
        className="w-full max-w-full overflow-x-auto bg-white dark:bg-slate-900 rounded-xl border border-gray-100 dark:border-slate-800 shadow-sm focus:outline-none"
        tabIndex={isVirtualized ? 0 : undefined}
        role={isVirtualized ? 'region' : undefined}
        aria-label={isVirtualized ? `${caption || 'Table'} scrollable view` : undefined}
      >
      <table
        className="min-w-max w-full text-sm text-left text-gray-600 dark:text-gray-300 border-collapse"
        aria-rowcount={isVirtualized ? totalRows + 1 : undefined}
      >
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead ref={headerRef} className="text-xs text-gray-500 dark:text-gray-400 uppercase bg-gray-50 dark:bg-slate-800/60 border-b border-gray-100 dark:border-slate-800 sticky top-0 z-10">
          <tr aria-rowindex={isVirtualized ? 1 : undefined}>
            {visibleColumns.map((col, idx) => (
              <th
                key={idx}
                scope="col"
                aria-sort={ariaSortFor(col)}
                className="px-4 sm:px-6 py-4 whitespace-nowrap bg-gray-50 dark:bg-slate-800"
              >
                {col.sortable ? (
                  renderSortButton(col)
                ) : (
                  col.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* Top virtual spacer */}
          {isVirtualized && topPadding > 0 && (
            <tr style={{ height: `${topPadding}px` }} aria-hidden="true">
              <td colSpan={visibleColumns.length} style={{ padding: 0, border: 'none' }} />
            </tr>
          )}

          {/* Visible Rows */}
          {visibleRows.map((row, relativeIdx) => {
            const absoluteIdx = isVirtualized ? startIndex + relativeIdx : relativeIdx;
            const rowKey = row[keyField] || absoluteIdx;
            const isClickable = Boolean(onRowClick);

            return (
              <tr
                key={rowKey}
                ref={(el) => {
                  if (el) rowRefs.current.set(absoluteIdx, el);
                  else rowRefs.current.delete(absoluteIdx);
                }}
                data-row-index={absoluteIdx}
                aria-rowindex={isVirtualized ? absoluteIdx + 2 : undefined}
                style={{ height: `${effectiveRowHeight}px` }}
                className={`border-b border-gray-50 dark:border-slate-800/60 hover:bg-gray-50/50 dark:hover:bg-slate-800/50 transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40 focus:bg-gray-100 dark:focus:bg-slate-800 ${rowClassName}`}
                onClick={isClickable ? () => onRowClick(row) : undefined}
                onKeyDown={(e) => handleKeyDown(e, absoluteIdx)}
                tabIndex={isClickable || isVirtualized ? 0 : undefined}
                aria-label={isClickable ? `View details for row ${absoluteIdx + 1}` : undefined}
              >
                {visibleColumns.map((col, colIdx) => (
                  <td key={colIdx} className={`px-4 sm:px-6 whitespace-nowrap ${densityConfig.className}`}>
                    {col.render ? col.render(row) : row[col.accessor]}
                  </td>
                ))}
              </tr>
            );
          })}

          {/* Bottom virtual spacer */}
          {isVirtualized && bottomPadding > 0 && (
            <tr style={{ height: `${bottomPadding}px` }} aria-hidden="true">
              <td colSpan={visibleColumns.length} style={{ padding: 0, border: 'none' }} />
            </tr>
          )}
        </tbody>
      </table>
      </div>
    </div>
  );
}
