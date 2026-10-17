// Deterministic mock data for the admin Transactions table, served through
// Playwright request interception with the same response contract as the MSW
// handlers in src/mocks/handlers.js ({ data, pagination }).

const STATUSES = ['success', 'pending', 'failed', 'processing'];
const TYPES = ['deposit', 'payout', 'transfer'];

// 25 transactions, one per day from 2026-03-01, newest first like the API.
export const TRANSACTIONS = Array.from({ length: 25 }, (_, index) => {
  const n = index + 1;
  const day = String(n).padStart(2, '0');
  return {
    _id: `tx_${String(n).padStart(3, '0')}`,
    txHash: `hash${String(n).padStart(4, '0')}abcdef`,
    type: TYPES[n % TYPES.length],
    status: STATUSES[n % STATUSES.length],
    // Mixed magnitudes so a text sort and a numeric sort disagree.
    amount: String((n * 37) % 250 + 0.5),
    asset: 'USDC',
    rail: 'stellar',
    destination: `GDEST${String(n).padStart(4, '0')}XXXXXXXXXXXX`,
    userId: { phoneNumber: `+23480000000${String(n).padStart(2, '0')}` },
    createdAt: `2026-03-${day}T12:00:00.000Z`,
  };
}).reverse();

export const DEFAULT_LIMIT = 10;

/**
 * Applies the query string the admin app sends to GET /admin/transactions:
 * identifier, phone, status, from, to (inclusive dates), limit, and the
 * `after` / `before` cursors (transaction ids).
 */
export function queryTransactions(searchParams, rows = TRANSACTIONS) {
  const identifier = searchParams.get('identifier')?.toLowerCase();
  const phone = searchParams.get('phone');
  const status = searchParams.get('status');
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  const limit = Number(searchParams.get('limit')) || DEFAULT_LIMIT;

  const filtered = rows.filter((tx) => {
    const day = tx.createdAt.slice(0, 10);
    return (
      (!identifier || tx._id.toLowerCase().includes(identifier) || tx.txHash.toLowerCase().includes(identifier)) &&
      (!phone || tx.userId.phoneNumber.includes(phone)) &&
      (!status || tx.status === status) &&
      (!from || day >= from) &&
      (!to || day <= to)
    );
  });

  let start = 0;
  const after = searchParams.get('after');
  const before = searchParams.get('before');
  if (after) start = filtered.findIndex((tx) => tx._id === after) + 1;
  if (before) start = Math.max(0, filtered.findIndex((tx) => tx._id === before) - limit);

  const page = filtered.slice(start, start + limit);
  const hasMore = start + limit < filtered.length;
  return {
    data: page,
    pagination: {
      limit,
      total: filtered.length,
      hasMore,
      nextCursor: hasMore ? page[page.length - 1]._id : null,
      prevCursor: start > 0 && page.length ? page[0]._id : null,
    },
  };
}
