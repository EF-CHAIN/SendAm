import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { describe, it, expect } from 'vitest';
import Wallets, { getWalletXlmBalance, calculateTxCapacity, LOW_RESERVE_THRESHOLD_XLM } from './Wallets';
import { server } from '@/mocks/server';

const renderPage = () => render(
  <MemoryRouter>
    <Wallets />
  </MemoryRouter>
);

// Helper – make the wallets endpoint return a known set of wallets.
const withWallets = (wallets) => {
  server.use(
    http.get('*/api/admin/wallets', () =>
      HttpResponse.json({
        data: wallets,
        pagination: { limit: 50, nextCursor: null, prevCursor: null, hasMore: false, total: wallets.length },
      })
    )
  );
};

// Minimal wallet factory
const makeWallet = (overrides) => ({
  _id: Math.random().toString(36).slice(2),
  publicKey: 'GCFUND' + Math.random().toString(36).slice(2, 14).toUpperCase().padEnd(50, 'A'),
  network: 'stellar',
  fundingState: 'funded',
  createdAt: '2024-01-01T00:00:00Z',
  userId: { phoneNumber: '+1234567890' },
  ...overrides,
});

// ---------------------------------------------------------------------------
// Existing error-handling tests (unchanged)
// ---------------------------------------------------------------------------
describe('Wallets error handling', () => {
  it('shows an alert banner instead of an empty table when the fetch fails', async () => {
    server.use(
      http.get('*/api/admin/wallets', () =>
        HttpResponse.json({ message: 'Database connection failed' }, { status: 500 })
      )
    );
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('A server error occurred');
    expect(alert.textContent).not.toContain('Database connection failed');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
  });

  it('re-attempts the fetch when Try Again is clicked', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/admin/wallets', () => {
        calls += 1;
        if (calls === 1) return HttpResponse.json({ message: 'boom' }, { status: 500 });
        return HttpResponse.json({
          data: [],
          pagination: { limit: 50, nextCursor: null, prevCursor: null, hasMore: false, total: 0 },
        });
      })
    );
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Try Again' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(calls).toBe(2);
    expect(await screen.findByText('No records found.')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ReserveAllocationGauge — empty state
// ---------------------------------------------------------------------------
describe('ReserveAllocationGauge – empty state', () => {
  it('renders the section heading and tier labels when no wallets are returned', async () => {
    withWallets([]);
    renderPage();

    expect(await screen.findByRole('heading', { name: /treasury reserve allocation/i })).toBeInTheDocument();
    // Legend should show all tier names with zero counts (sr-only dt + visible span each render the label)
    expect(screen.getAllByText(/Hot Reserve/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Channel Accounts/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Escrow Vaults/).length).toBeGreaterThan(0);
    // No progressbar segments when empty
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0);

  });
});

// ---------------------------------------------------------------------------
// ReserveAllocationGauge — populated state
// ---------------------------------------------------------------------------
describe('ReserveAllocationGauge – populated', () => {
  it('renders progressbar segments with correct aria-valuenow per tier', async () => {
    withWallets([
      makeWallet({ network: 'stellar', fundingState: 'funded' }),   // Hot
      makeWallet({ network: 'stellar', fundingState: 'funded' }),   // Hot
      makeWallet({ network: 'stellar', fundingState: 'pending' }),  // Channel
      makeWallet({ network: 'ethereum', fundingState: 'funded' }),  // Escrow
    ]);
    renderPage();

    await screen.findByRole('heading', { name: /treasury reserve allocation/i });

    const bars = screen.getAllByRole('progressbar');
    expect(bars).toHaveLength(3);

    // Hot Reserve: 2/4 = 50%
    const hotBar = bars.find((b) => b.getAttribute('aria-label')?.includes('Hot Reserve'));
    expect(hotBar).toBeDefined();
    expect(hotBar.getAttribute('aria-valuenow')).toBe('50');

    // Channel Accounts: 1/4 = 25%
    const channelBar = bars.find((b) => b.getAttribute('aria-label')?.includes('Channel Accounts'));
    expect(channelBar).toBeDefined();
    expect(channelBar.getAttribute('aria-valuenow')).toBe('25');

    // Escrow Vaults: 1/4 = 25%
    const escrowBar = bars.find((b) => b.getAttribute('aria-label')?.includes('Escrow Vaults'));
    expect(escrowBar).toBeDefined();
    expect(escrowBar.getAttribute('aria-valuenow')).toBe('25');
  });

  it('omits a segment when its tier count is zero', async () => {
    // Only hot-reserve wallets – no channel or escrow entries
    withWallets([
      makeWallet({ network: 'stellar', fundingState: 'funded' }),
      makeWallet({ network: 'stellar-testnet', fundingState: 'funded' }),
    ]);
    renderPage();

    await screen.findByRole('heading', { name: /treasury reserve allocation/i });

    const bars = screen.getAllByRole('progressbar');
    expect(bars).toHaveLength(1);
    expect(bars[0].getAttribute('aria-valuenow')).toBe('100');
const walletsResponse = (data) => HttpResponse.json({
  data,
  pagination: { limit: 50, nextCursor: null, prevCursor: null, hasMore: false, total: data.length },
});

const KEY_LOW = 'GLOWRESERVEACCOUNTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const KEY_OK = 'GHEALTHYACCOUNTBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

describe('Wallets low XLM reserve warnings', () => {
  it('shows a warning banner and Refill Account instructions for accounts under 20 XLM', async () => {
    server.use(
      http.get('*/api/admin/wallets', () => walletsResponse([
        { _id: 'w1', publicKey: KEY_LOW, network: 'testnet', xlmBalance: '12.5', userId: { phoneNumber: '+1' }, createdAt: '2026-01-01T00:00:00Z' },
        { _id: 'w2', publicKey: KEY_OK, network: 'testnet', xlmBalance: '250', userId: { phoneNumber: '+2' }, createdAt: '2026-01-01T00:00:00Z' },
      ]))
    );
    renderPage();

    const region = await screen.findByRole('region', { name: /low xlm reserve warning/i });
    expect(region).toHaveTextContent('1 account');
    expect(region).toHaveTextContent('12.50 XLM');
    expect(region).not.toHaveTextContent('250.00 XLM');

    await userEvent.click(screen.getAllByRole('button', { name: /refill account/i })[0]);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Refill Account Instructions');
    expect(dialog.querySelector('input').value).toBe(KEY_LOW);
  });

  it('shows no warning when every account is at or above the threshold', async () => {
    server.use(
      http.get('*/api/admin/wallets', () => walletsResponse([
        { _id: 'w1', publicKey: KEY_OK, network: 'testnet', xlmBalance: '20', userId: { phoneNumber: '+1' }, createdAt: '2026-01-01T00:00:00Z' },
      ]))
    );
    renderPage();

    expect(await screen.findByText('20.00 XLM')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /low xlm reserve warning/i })).not.toBeInTheDocument();
  });

  it('does not warn for wallets that report no balance', async () => {
    server.use(
      http.get('*/api/admin/wallets', () => walletsResponse([
        { _id: 'w1', publicKey: KEY_OK, network: 'testnet', userId: { phoneNumber: '+1' }, createdAt: '2026-01-01T00:00:00Z' },
      ]))
    );
    renderPage();

    await screen.findByRole('table');
    expect(screen.queryByRole('region', { name: /low xlm reserve warning/i })).not.toBeInTheDocument();
  });
});

describe('wallet reserve helpers', () => {
  it('reads the native balance from the supported shapes', () => {
    expect(getWalletXlmBalance({ xlmBalance: '5' })).toBe(5);
    expect(getWalletXlmBalance({ balances: [{ asset_type: 'credit_alphanum4', balance: '9' }, { asset_type: 'native', balance: '7.5' }] })).toBe(7.5);
    expect(getWalletXlmBalance({})).toBeNull();
    expect(getWalletXlmBalance({ xlmBalance: 'abc' })).toBeNull();
  });

  it('computes remaining transaction capacity above the 1 XLM minimum reserve', () => {
    expect(calculateTxCapacity(1)).toBe(0);
    expect(calculateTxCapacity(0.5)).toBe(0);
    expect(calculateTxCapacity(2)).toBe(100000);
    expect(calculateTxCapacity(null)).toBeNull();
  });

  it('uses a 20 XLM threshold', () => {
    expect(LOW_RESERVE_THRESHOLD_XLM).toBe(20);
  });
});
