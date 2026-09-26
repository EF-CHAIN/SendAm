import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';

/**
 * Generic data table with optional row-click support.
 *
 * Props:
 *   columns      — array of { header, accessor?, render?, sortable? }
 *   data         — array of row objects
 *   keyField     — unique key field name (default: 'id')
 *   onRowClick   — optional (row) => void handler; makes rows focusable / clickable
 *   rowClassName — optional extra class(es) added to every <tr>
 *   defaultSort  — optional { key, direction } to sort by on first render
 *
 * A column opts into sorting with `sortable: true`. DataTable then owns the
 * sort state and keeps `aria-sort` in sync on the column header, so assistive
 * technology can announce the current sort after every toggle (WCAG 2.2
 * 1.3.1 Info and Relationships; ARIA `aria-sort` only allows one 'ascending' /
 * 'descending' column at a time — the rest report 'none').
 */

const FOCUSABLE_HEADER = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

// Dates are stored as ISO strings, so compare them chronologically instead of
// lexically. Everything else falls back to a locale compare with numeric
// collation so "item 2" sorts before "item 10".
function compareValues(a, b) {
  if (a === b) return 0;
  // Always push empty values to the end, in both directions.
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
  if (!sort) return data;
  const key = sort.key;
  const column = columns.find((c) => c.sortable && (c.accessor ?? c.header) === key);
  if (!column) return data;
  const factor = sort.direction === 'descending' ? -1 : 1;
  // Slice() so we never mutate the caller's array.
  return [...data].sort((a, b) => factor * compareValues(a[key], b[key]));
}

export default function DataTable({
  columns,
  data,
  keyField = 'id',
  onRowClick,
  rowClassName = '',
  defaultSort = null,
}) {
  const [sort, setSort] = useState(defaultSort);

  const sortKeyOf = (column) => column.accessor ?? column.header;
  const rows = useMemo(() => sortRows(data, columns, sort), [data, columns, sort]);

  const handleSort = (column) => {
    const key = sortKeyOf(column);
    setSort((current) =>
      current?.key !== key
        ? { key, direction: 'ascending' }
        : { key, direction: current.direction === 'ascending' ? 'descending' : 'ascending' }
    );
  };

  // Per ARIA: 'ascending'/'descending' on the active column, 'none' on the other
  // sortable columns, and no aria-sort at all on columns that cannot be sorted.
  const ariaSortFor = (column) => {
    if (!column.sortable) return undefined;
    if (sort?.key !== sortKeyOf(column)) return 'none';
    return sort.direction === 'descending' ? 'descending' : 'ascending';
  };

  if (!data || data.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500 bg-white rounded-xl border border-gray-100">
        No records found.
      </div>
    );
  }

  const handleRowKeyDown = (e, row) => {
    if (onRowClick && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onRowClick(row);
    }
  };

  return (
    <div className="w-full max-w-full overflow-x-auto bg-white rounded-xl border border-gray-100 shadow-sm">
      <table className="min-w-max w-full text-sm text-left text-gray-600">
        <thead className="text-xs text-gray-500 uppercase bg-gray-50 border-b border-gray-100">
          <tr>
            {columns.map((col, idx) => (
              <th
                key={idx}
                scope="col"
                aria-sort={ariaSortFor(col)}
                className="px-4 sm:px-6 py-4 whitespace-nowrap"
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
          {rows.map((row, idx) => (
            <tr
              key={row[keyField] || idx}
              className={`border-b border-gray-50 hover:bg-gray-50/50 transition-colors ${rowClassName}`}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onRowClick ? (e) => handleRowKeyDown(e, row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              aria-label={onRowClick ? `View details for row ${idx + 1}` : undefined}
            >
              {columns.map((col, colIdx) => (
                <td key={colIdx} className="px-4 sm:px-6 py-4 whitespace-nowrap">
                  {col.render ? col.render(row) : row[col.accessor]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
