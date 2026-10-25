import { test, expect } from '@playwright/test';
import { TRANSACTIONS, queryTransactions } from './fixtures/transactions.js';

// End-to-end coverage for the admin DataTable on the Transactions page (#829):
// text search, date range, column sorting and cursor pagination, with every
// control kept in sync with the URL query string.

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };

test.describe('Admin DataTable: search, date range, sorting, pagination', () => {
  /** Query strings received by the mocked API, newest last. */
  let requests;

  test.beforeEach(async ({ page }) => {
    requests = [];
    await page.addInitScript(() => localStorage.setItem('adminToken', 'e2e-token'));
    await page.route('**/api/admin/me', (route) =>
      route.fulfill({ json: { data: { permissions: ['*'] } }, headers: CORS }),
    );
    await page.route(/\/api\/admin\/transactions(\?|$)/, (route) => {
      const url = new URL(route.request().url());
      requests.push(url.searchParams);
      return route.fulfill({ json: queryTransactions(url.searchParams), headers: CORS });
    });
  });

  const table = (page) => page.getByRole('table', { name: 'Transactions' });
  const bodyRows = (page) => table(page).locator('tbody tr');
  const idCells = (page) => bodyRows(page).locator('td:first-child');
  const search = (page) => new URL(page.url()).searchParams;
  // The global search modal also preloads `?limit=100`; keep only the
  // table's own requests.
  const tableRequests = () =>
    requests.filter((params) => !(params.get('limit') === '100' && [...params.keys()].length === 1));
  const lastRequest = () => tableRequests().at(-1);

  const open = async (page, query = '') => {
    await page.goto(`/transactions${query}`);
    await expect(table(page)).toBeVisible();
  };

  test('loads the first page of mock data', async ({ page }) => {
    await open(page);
    await expect(bodyRows(page)).toHaveCount(10);
    await expect(idCells(page).first()).toHaveText('hash0025ab…');
    await expect(page.getByText('Total: 25').first()).toBeVisible();
  });

  test('text search filters rows and is written to the URL and the API call', async ({ page }) => {
    await open(page);
    await page.getByTestId('filter-identifier').fill('hash002');
    // hash0020 .. hash0025
    await expect(bodyRows(page)).toHaveCount(6);
    expect(search(page).get('identifier')).toBe('hash002');
    expect(lastRequest().get('identifier')).toBe('hash002');

    await page.getByTestId('filter-identifier').fill('tx_007');
    await expect(bodyRows(page)).toHaveCount(1);
    await expect(idCells(page)).toHaveText(['hash0007ab…']);

    await page.getByTestId('filter-identifier').fill('no-such-transaction');
    await expect(page.getByRole('region', { name: /empty state/i })).toBeVisible();
    await page.getByRole('button', { name: 'Reset Filters' }).click();
    await expect(bodyRows(page)).toHaveCount(10);
    expect(search(page).has('identifier')).toBe(false);
  });

  test('date range inputs narrow results inclusively and sync to the URL', async ({ page }) => {
    await open(page);
    await page.getByTestId('filter-from').fill('2026-03-05');
    await expect(page).toHaveURL(/from=2026-03-05/);
    await page.getByTestId('filter-to').fill('2026-03-08');
    await expect(bodyRows(page)).toHaveCount(4);
    await expect(idCells(page)).toHaveText(['hash0008ab…', 'hash0007ab…', 'hash0006ab…', 'hash0005ab…']);
    expect(search(page).get('from')).toBe('2026-03-05');
    expect(search(page).get('to')).toBe('2026-03-08');
    expect(tableRequests().at(-1).get('from')).toBe('2026-03-05');
    expect(tableRequests().at(-1).get('to')).toBe('2026-03-08');

    // A range that ends before it starts matches nothing.
    await page.getByTestId('filter-from').fill('2026-03-20');
    await expect(page.getByRole('region', { name: /empty state/i })).toBeVisible();
  });

  test('column headers sort ascending then descending and persist in the URL', async ({ page }) => {
    await open(page);
    const amountHeader = table(page).getByRole('columnheader', { name: /amount/i });
    const amountCells = bodyRows(page).locator('td:nth-child(4)');
    const pageAmounts = TRANSACTIONS.slice(0, 10).map((tx) => Number(tx.amount));
    const asText = (values) => values.map((v) => `${v} USDC`);
    const fetchesBeforeSort = tableRequests().length;

    await amountHeader.getByRole('button').click();
    await expect(amountHeader).toHaveAttribute('aria-sort', 'ascending');
    await expect(amountCells).toHaveText(asText([...pageAmounts].sort((a, b) => a - b)));
    expect(search(page).get('sort')).toBe('amount');
    expect(search(page).get('dir')).toBe('asc');

    await amountHeader.getByRole('button').click();
    await expect(amountHeader).toHaveAttribute('aria-sort', 'descending');
    await expect(amountCells).toHaveText(asText([...pageAmounts].sort((a, b) => b - a)));
    expect(search(page).get('dir')).toBe('desc');

    // Sorting is client-side: it never refetches or sends sort params.
    expect(tableRequests()).toHaveLength(fetchesBeforeSort);
    expect(requests.every((params) => !params.has('sort'))).toBe(true);

    // A reload restores the sorted view from the URL.
    await page.reload();
    await expect(table(page).getByRole('columnheader', { name: /amount/i })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    await expect(amountCells.first()).toHaveText(asText([Math.max(...pageAmounts)]));
  });

  test('pagination moves by cursor, changes page size, and resets on filter change', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: /next/i }).click();
    await expect(idCells(page).first()).toHaveText('hash0015ab…');
    expect(search(page).get('after')).toBe('tx_016');
    expect(lastRequest().get('after')).toBe('tx_016');

    await page.getByRole('button', { name: /next/i }).click();
    await expect(bodyRows(page)).toHaveCount(5);
    await expect(page.getByRole('button', { name: /next/i })).toBeDisabled();

    await page.getByRole('button', { name: /prev/i }).click();
    await expect(idCells(page).first()).toHaveText('hash0015ab…');
    expect(search(page).has('after')).toBe(false);
    expect(search(page).get('before')).toBe('tx_005');

    await page.getByLabel('Items per page').selectOption('25');
    await expect(bodyRows(page)).toHaveCount(25);
    expect(search(page).get('limit')).toBe('25');
    expect(search(page).has('before')).toBe(false);

    await page.getByTestId('filter-status').selectOption('failed');
    expect(search(page).has('after')).toBe(false);
    await expect(bodyRows(page)).toHaveCount(TRANSACTIONS.filter((tx) => tx.status === 'failed').length);
  });

  test('a deep link restores filters, page size and sort together', async ({ page }) => {
    await open(page, '?status=success&limit=25&sort=createdAt&dir=asc');
    await expect(page.getByTestId('filter-status')).toHaveValue('success');
    await expect(table(page).getByRole('columnheader', { name: /date/i })).toHaveAttribute('aria-sort', 'ascending');
    const expected = TRANSACTIONS.filter((tx) => tx.status === 'success').map((tx) => `${tx.txHash.slice(0, 10)}…`).reverse();
    await expect(idCells(page)).toHaveText(expected);
    expect(lastRequest().get('status')).toBe('success');
    expect(lastRequest().get('limit')).toBe('25');
    expect(lastRequest().has('sort')).toBe(false);
  });
});
