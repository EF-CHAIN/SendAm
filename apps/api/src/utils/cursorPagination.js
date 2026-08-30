// Bounded cursor (keyset) pagination shared by every admin list endpoint.
//
// Offset (`skip`/`take`) pagination degrades and, worse, skips or duplicates
// rows when rows are inserted concurrently between page requests. Keyset
// pagination compares the stable (sortField, id) tuple instead, so new inserts
// never shift the window. `id` is the tie-breaker that makes the sort total
// ordering even when `sortField` values collide.
//
// Cursors are opaque base64url strings encoding `{ id, sortField, value }`.
// They are validated against the endpoint's expected sortField so a cursor
// from one list can never be replayed against another.

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
const MAX_EXPORT_ROWS = 5000;

const parseLimit = (raw, max = MAX_PAGE_SIZE) => {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(max, n);
};

const encodeCursor = (row, sortField = 'createdAt') => {
  const value = row[sortField];
  const payload = JSON.stringify({
    i: row.id,
    s: sortField,
    v: value instanceof Date ? value.toISOString() : value,
  });
  return Buffer.from(payload, 'utf8').toString('base64url');
};

const decodeCursor = (cursor, expectedSortField = 'createdAt') => {
  if (!cursor || typeof cursor !== 'string') {
    const error = new Error('Invalid cursor');
    error.statusCode = 400;
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    const error = new Error('Invalid cursor');
    error.statusCode = 400;
    throw error;
  }
  if (!payload || typeof payload.i !== 'string' || payload.s !== expectedSortField) {
    const error = new Error('Invalid cursor');
    error.statusCode = 400;
    throw error;
  }
  return {
    id: payload.i,
    sortField: payload.s,
    value: payload.v ? new Date(payload.v) : payload.v,
  };
};

// Build the where-clause fragment that selects rows strictly before (desc) or
// after (asc) the cursor in (sortField, id) order.
const keysetWhere = (cursor, direction, sortField) => {
  const cmp = direction === 'asc' ? 'gt' : 'lt';
  if (cursor.value == null) {
    return { id: { [cmp]: cursor.id } };
  }
  return {
    OR: [
      { [sortField]: { [cmp]: cursor.value } },
      { [sortField]: cursor.value, id: { [cmp]: cursor.id } },
    ],
  };
};

// Run a bounded keyset query and return the page plus opaque cursors.
// `orderBy` describes the display order, e.g. { createdAt: 'desc' }.
// `after` walks forward (older), `before` walks backward (newer).
const cursorQuery = async ({
  delegate,
  where = {},
  orderBy,
  sortField = 'createdAt',
  include,
  select,
  limit,
  after,
  before,
}) => {
  const ascending = orderBy?.[sortField] === 'asc';
  const displayDir = ascending ? 'asc' : 'desc';

  let navCursor = null;
  let navDir = displayDir;
  if (before) {
    navCursor = decodeCursor(before, sortField);
    navDir = ascending ? 'desc' : 'asc';
  } else if (after) {
    navCursor = decodeCursor(after, sortField);
    navDir = displayDir;
  }

  const findWhere = { ...where };
  if (navCursor) {
    Object.assign(findWhere, keysetWhere(navCursor, navDir, sortField));
  }

  const rows = await delegate.findMany({
    where: findWhere,
    orderBy: [{ [sortField]: navDir }, { id: navDir }],
    take: limit + 1,
    ...(include ? { include } : {}),
    ...(select ? { select } : {}),
  });

  const hasMore = rows.length > limit;
  let page = rows.slice(0, limit);
  if (navDir === 'asc') page = page.reverse();

  if (page.length === 0) {
    return { items: [], nextCursor: null, prevCursor: null, hasMore: false };
  }

  const first = page[0];
  const last = page[page.length - 1];

  let nextCursor = null;
  let prevCursor = null;
  if (before) {
    nextCursor = encodeCursor(last, sortField);
    prevCursor = hasMore ? encodeCursor(first, sortField) : null;
  } else if (after) {
    nextCursor = hasMore ? encodeCursor(last, sortField) : null;
    prevCursor = encodeCursor(first, sortField);
  } else {
    nextCursor = hasMore ? encodeCursor(last, sortField) : null;
    prevCursor = null;
  }

  return { items: page, nextCursor, prevCursor, hasMore };
};

module.exports = {
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  MAX_EXPORT_ROWS,
  parseLimit,
  encodeCursor,
  decodeCursor,
  keysetWhere,
  cursorQuery,
};
