const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encodeCursor, decodeCursor, cursorQuery, parseLimit, MAX_PAGE_SIZE } = require('../src/utils/cursorPagination');

// Minimal in-memory Prisma delegate that honours the where/orderBy/take subset
// the cursor helper emits, so we can assert real pagination behaviour.
const matches = (row, where) => {
  if (!where || Object.keys(where).length === 0) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return cond.some((sub) => matches(row, sub));
    if (key === 'AND') return cond.every((sub) => matches(row, sub));
    if (key === 'user' || key === 'wallet') return matches(row[key] || {}, cond);
    const value = row[key];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      return Object.entries(cond).every(([op, operand]) => {
        const eq = (a, b) => (a instanceof Date || b instanceof Date)
          ? new Date(a).getTime() === new Date(b).getTime()
          : a === b;
        switch (op) {
          case 'equals': return eq(value, operand);
          case 'contains': return String(value).toLowerCase().includes(String(operand).toLowerCase());
          case 'gte': return new Date(value) >= new Date(operand);
          case 'lte': return new Date(value) <= new Date(operand);
          case 'gt': return new Date(value) > new Date(operand);
          case 'lt': return new Date(value) < new Date(operand);
          default: return false;
        }
      });
    }
    return eq(value, cond);
  });
};

const makeDelegate = (rows) => ({
  findMany: async ({ where = {}, orderBy = [], take } = {}) => {
    const ob = Array.isArray(orderBy) ? orderBy : [orderBy];
    const sorted = [...rows].sort((a, b) => {
      for (const o of ob) {
        const [field, dir] = Object.entries(o)[0];
        const av = a[field]; const bv = b[field];
        if (av < bv) return dir === 'asc' ? -1 : 1;
        if (av > bv) return dir === 'asc' ? 1 : -1;
      }
      return 0;
    });
    const filtered = sorted.filter((r) => matches(r, where));
    return take == null ? filtered : filtered.slice(0, take);
  },
});

const makeRows = (n) => Array.from({ length: n }, (_, i) => ({
  id: `id-${String(i).padStart(3, '0')}`,
  createdAt: new Date(2024, 0, 1 + i),
  status: i % 2 === 0 ? 'success' : 'failed',
})).reverse(); // newest first by id/date

test('parseLimit bounds the page size', () => {
  assert.equal(parseLimit(undefined), 50);
  assert.equal(parseLimit('0'), 50);
  assert.equal(parseLimit('-5'), 50);
  assert.equal(parseLimit('10'), 10);
  assert.equal(parseLimit('99999'), MAX_PAGE_SIZE);
});

test('invalid cursors throw a 400 error', () => {
  assert.throws(() => decodeCursor('not-base64', 'createdAt'), (e) => e.statusCode === 400);
  assert.throws(() => decodeCursor(encodeCursor({ id: 'x', createdAt: new Date() }, 'createdAt'), 'updatedAt'), (e) => e.statusCode === 400);
});

test('forward + backward traversal returns every row once, no dupes', async () => {
  const rows = makeRows(7);
  const delegate = makeDelegate(rows);

  const page1 = await cursorQuery({ delegate, where: {}, orderBy: { createdAt: 'desc' }, sortField: 'createdAt', limit: 3 });
  assert.equal(page1.items.length, 3);
  assert.equal(page1.hasMore, true);
  assert.ok(page1.nextCursor);

  const page2 = await cursorQuery({ delegate, where: {}, orderBy: { createdAt: 'desc' }, sortField: 'createdAt', limit: 3, after: page1.nextCursor });
  assert.equal(page2.items.length, 3);
  assert.ok(page2.nextCursor);
  assert.ok(page2.prevCursor);

  const page3 = await cursorQuery({ delegate, where: {}, orderBy: { createdAt: 'desc' }, sortField: 'createdAt', limit: 3, after: page2.nextCursor });
  assert.equal(page3.items.length, 1);
  assert.equal(page3.hasMore, false);

  const all = [...page1.items, ...page2.items, ...page3.items].map((r) => r.id);
  assert.equal(new Set(all).size, 7);
  assert.equal(all.length, 7);
});

test('backward cursor returns to the previous page', async () => {
  const rows = makeRows(5);
  const delegate = makeDelegate(rows);

  const p1 = await cursorQuery({ delegate, where: {}, orderBy: { createdAt: 'desc' }, sortField: 'createdAt', limit: 2 });
  const p2 = await cursorQuery({ delegate, where: {}, orderBy: { createdAt: 'desc' }, sortField: 'createdAt', limit: 2, after: p1.nextCursor });
  const back = await cursorQuery({ delegate, where: {}, orderBy: { createdAt: 'desc' }, sortField: 'createdAt', limit: 2, before: p2.prevCursor });

  assert.deepEqual(back.items.map((r) => r.id), p1.items.map((r) => r.id));
});

test('concurrent insert does not shift the cursor window', async () => {
  const rows = makeRows(6);
  const delegate = makeDelegate(rows);
  const limit = 2;

  const p1 = await cursorQuery({ delegate, where: {}, orderBy: { createdAt: 'desc' }, sortField: 'createdAt', limit });
  const lastSeen = p1.items[p1.items.length - 1].id;

  // A newer row is inserted while the operator is on page 1.
  rows.push({ id: 'id-new', createdAt: new Date(2024, 0, 99), status: 'success' });

  const p2 = await cursorQuery({ delegate, where: {}, orderBy: { createdAt: 'desc' }, sortField: 'createdAt', limit, after: p1.nextCursor });
  assert.ok(!p2.items.map((r) => r.id).includes(lastSeen));
  assert.ok(!p2.items.map((r) => r.id).includes('id-new'));
});

test('filters are applied before pagination', async () => {
  const rows = makeRows(6);
  const delegate = makeDelegate(rows);
  const result = await cursorQuery({
    delegate,
    where: { status: { equals: 'success' } },
    orderBy: { createdAt: 'desc' },
    sortField: 'createdAt',
    limit: 3,
  });
  assert.ok(result.items.every((r) => r.status === 'success'));
});
