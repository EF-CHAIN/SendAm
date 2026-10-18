import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
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

const FOCUSABLE_HEADER = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

// Pagination cursors and page size are not filters — they must not trigger the
// "Reset Filters" recovery action in the empty state.
const NON_FILTER_PARAMS = new Set(['after', 'before', 'limit']);

function compareValues(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined || a === '') return 1;
  if (b === null || b === undefined || b === '') return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);

  const aTime = Date.parse(a);
  const bTime = Date.parse(b);
  if (!Number.isNaN(aTime) && !Number.isNaN(bTime)) return aTime - bTime;

  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function sortRows(data, columns, sort) {
  if (!sort || !data) return data || [];
  const key = sort.key;
  const column = columns.find((c) => c.sortable && (c.accessor ?? c.header) === key);
  if (!column) return data;
  const factor = sort.direction === 'descending' ? -1 : 1;
  return [...data].sort((a, b) => factor * compareValues(a[key], b[key]));
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
  rowHeight = 53,
  maxHeight = 600,
  overscan = 5,
  virtualizeThreshold = 50,
  storageKey,
}) {
  const [sort, setSort] = useState(defaultSort);

  // Column visibility/order preferences, scoped to this table by storageKey or
  // the caption so different tables do not share a saved layout.
  const storageId = storageKey || `datatable:columns:${caption || 'default'}`;
  const [columnPrefs, setColumnPrefs] = useState(() => {
    const stored = readColumnPrefs(storageId);
    if (!stored) return { order: columns.map(columnId), hidden: [] };
    return reconcileColumnPrefs(stored, columns);
  });
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const customizeRef = useRef(null);

  const [searchParams, setSearchParams] = useSearchParams();
  const hasActiveFilters =
    filtersActive ??
    Array.from(searchParams.keys()).some((key) => !NON_FILTER_PARAMS.has(key));

  const sortKeyOf = (column) => column.accessor ?? column.header;
  const sortedData = useMemo(() => sortRows(data, columns, sort), [data, columns, sort]);

  const handleSort = (column) => {
    const key = sortKeyOf(column);
    setSort((current) =>
      current?.key !== key
        ? { key, direction: 'ascending' }
        : { key, direction: current.direction === 'ascending' ? 'descending' : 'ascending' }
    );
  };

  const ariaSortFor = (column) => {
    if (!column.sortable) return undefined;
    if (sort?.key !== sortKeyOf(column)) return 'none';
    return sort.direction === 'descending' ? 'descending' : 'ascending';
  };

  const containerRef = useRef(null);
  const rowRefs = useRef(new Map());
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(
    typeof maxHeight === 'number' ? maxHeight : 600
  );
  const [focusedIndex, setFocusedIndex] = useState(null);

  // Keep preferences in sync when the columns prop changes.
  useEffect(() => {
    setColumnPrefs((current) => reconcileColumnPrefs(current, columns));
  }, [columns]);

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

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateHeight = () => {
      if (el.clientHeight > 0) {
        setContainerHeight(el.clientHeight);
      }
    };

    updateHeight();

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateHeight);
      observer.observe(el);
      return () => observer.disconnect();
    }
  }, []);

  const handleScroll = useCallback((e) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

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

    const calculatedStart = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const visibleCount = Math.ceil(containerHeight / rowHeight);
    const calculatedEnd = Math.min(totalRows - 1, calculatedStart + visibleCount + overscan * 2);

    const start = Math.max(0, calculatedStart);
    const end = Math.min(totalRows - 1, calculatedEnd);

    const topPad = start * rowHeight;
    const bottomPad = Math.max(0, (totalRows - 1 - end) * rowHeight);
    const sliced = sortedData.slice(start, end + 1);

    return {
      startIndex: start,
      endIndex: end,
      topPadding: topPad,
      bottomPadding: bottomPad,
      visibleRows: sliced,
    };
  }, [isVirtualized, totalRows, scrollTop, rowHeight, overscan, containerHeight, sortedData]);

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

      const targetTop = targetIndex * rowHeight;
      const targetBottom = targetTop + rowHeight;
      const currentScrollTop = el.scrollTop || scrollTop;
      const viewHeight = el.clientHeight || containerHeight;

      let newScrollTop = null;
      if (targetTop < currentScrollTop) {
        newScrollTop = targetTop;
      } else if (targetBottom > currentScrollTop + viewHeight) {
        newScrollTop = targetBottom - viewHeight;
      }

      if (newScrollTop != null) {
        el.scrollTop = newScrollTop;
        setScrollTop(newScrollTop);
      }
    },
    [totalRows, rowHeight, scrollTop, containerHeight]
  );

  const focusRow = useCallback(
    (index) => {
      const targetIndex = Math.max(0, Math.min(totalRows - 1, index));
      setFocusedIndex(targetIndex);
      scrollRowIntoView(targetIndex);
      const domEl = rowRefs.current.get(targetIndex);
      if (domEl) {
        domEl.focus();
      }
    },
    [totalRows, scrollRowIntoView]
  );

  useEffect(() => {
    if (focusedIndex != null) {
      const domEl = rowRefs.current.get(focusedIndex);
      if (domEl && document.activeElement !== domEl) {
        domEl.focus();
      }
    }
  }, [focusedIndex, visibleRows]);

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
      }
    : undefined;

  return (
    <div className="w-full">
      <div className="mb-2 flex justify-end">
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
      className="w-full max-w-full overflow-x-auto bg-white dark:bg-slate-900 rounded-xl border border-gray-100 dark:border-slate-800 shadow-sm focus:outline-none"
      tabIndex={isVirtualized ? 0 : undefined}
      aria-label={caption ? `${caption} scrollable view` : undefined}
    >
      <table className="min-w-max w-full text-sm text-left text-gray-600 dark:text-gray-300 border-collapse">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="text-xs text-gray-500 dark:text-gray-400 uppercase bg-gray-50 dark:bg-slate-800/60 border-b border-gray-100 dark:border-slate-800 sticky top-0 z-10">
          <tr>
            {visibleColumns.map((col, idx) => (
              <th
                key={idx}
                scope="col"
                aria-sort={ariaSortFor(col)}
                className="px-4 sm:px-6 py-4 whitespace-nowrap bg-gray-50 dark:bg-slate-800"
              >
                {col.sortable ? (
                  <button
                    type="button"
                    onClick={() => handleSort(col)}
                    className={`inline-flex items-center gap-1.5 uppercase font-semibold ${FOCUSABLE_HEADER}`}
                  >
                    {col.header}
                    {sort?.key === sortKeyOf(col) ? (
                      sort.direction === 'ascending' ? (
                        <ArrowUp size={14} aria-hidden="true" />
                      ) : (
                        <ArrowDown size={14} aria-hidden="true" />
                      )
                    ) : (
                      <ChevronsUpDown size={14} aria-hidden="true" />
                    )}
                  </button>
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
                className={`border-b border-gray-50 dark:border-slate-800/60 hover:bg-gray-50/50 dark:hover:bg-slate-800/50 transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40 focus:bg-gray-100 dark:focus:bg-slate-800 ${rowClassName}`}
                onClick={isClickable ? () => onRowClick(row) : undefined}
                onKeyDown={(e) => handleKeyDown(e, absoluteIdx)}
                tabIndex={isClickable || isVirtualized ? 0 : undefined}
                aria-label={isClickable ? `View details for row ${absoluteIdx + 1}` : undefined}
              >
                {visibleColumns.map((col, colIdx) => (
                  <td key={colIdx} className="px-4 sm:px-6 py-4 whitespace-nowrap">
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
