// Sorting helpers shared by DataTable and its tests.

// URL encoding of the sort state when `syncSortWithUrl` is on:
// `?sort=<column accessor>&dir=asc|desc`.
const DIR_TO_DIRECTION = { asc: 'ascending', desc: 'descending' };
export const DIRECTION_TO_DIR = { ascending: 'asc', descending: 'desc' };

export function sortFromSearchParams(searchParams, columns) {
  const key = searchParams.get('sort');
  const direction = DIR_TO_DIRECTION[searchParams.get('dir') ?? 'asc'];
  if (!key || !direction) return null;
  const valid = columns.some((c) => c.sortable && (c.accessor ?? c.header) === key);
  return valid ? { key, direction } : null;
}

const NUMERIC_STRING = /^-?\d+(\.\d+)?$/;

export function compareValues(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined || a === '') return 1;
  if (b === null || b === undefined || b === '') return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  // Decimal strings (API amounts such as "25.5") compare as numbers. Checked
  // before Date.parse, which would read "100" as the year 100.
  if (NUMERIC_STRING.test(String(a)) && NUMERIC_STRING.test(String(b))) return Number(a) - Number(b);

  const aTime = Date.parse(a);
  const bTime = Date.parse(b);
  if (!Number.isNaN(aTime) && !Number.isNaN(bTime)) return aTime - bTime;

  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}
