import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import Breadcrumbs from './Breadcrumbs.jsx';

const renderWithRouter = (initialPath = '/') => {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Breadcrumbs />
    </MemoryRouter>
  );
};

describe('Breadcrumbs Component', () => {
  it('returns null on root path /', () => {
    const { container } = renderWithRouter('/');
    expect(container.firstChild).toBeNull();
  });

  it('renders navigation landmark with aria-label="Breadcrumb" on subroutes', () => {
    renderWithRouter('/transactions');
    const nav = screen.getByRole('navigation', { name: /breadcrumb/i });
    expect(nav).toBeInTheDocument();
  });

  it('renders Dashboard link and active Transactions item on /transactions', () => {
    renderWithRouter('/transactions');

    const dashboardLink = screen.getByRole('link', { name: /dashboard/i });
    expect(dashboardLink).toBeInTheDocument();
    expect(dashboardLink).toHaveAttribute('href', '/');

    const transactionsCurrent = screen.getByText('Transactions');
    expect(transactionsCurrent).toBeInTheDocument();
    expect(transactionsCurrent).toHaveAttribute('aria-current', 'page');
  });

  it('renders full breadcrumb hierarchy with clickable parent links for deep route /transactions/SDA-9284', () => {
    renderWithRouter('/transactions/SDA-9284');

    const dashboardLink = screen.getByRole('link', { name: /dashboard/i });
    expect(dashboardLink).toHaveAttribute('href', '/');

    const transactionsLink = screen.getByRole('link', { name: /transactions/i });
    expect(transactionsLink).toHaveAttribute('href', '/transactions');

    const idCurrent = screen.getByText('SDA-9284');
    expect(idCurrent).toBeInTheDocument();
    expect(idCurrent).toHaveAttribute('aria-current', 'page');
  });

  it('correctly formats route names for /audit-logs and /system-health', () => {
    const { unmount } = renderWithRouter('/audit-logs');
    expect(screen.getByText('Audit Logs')).toHaveAttribute('aria-current', 'page');
    unmount();

    renderWithRouter('/system-health');
    expect(screen.getByText('System Health')).toHaveAttribute('aria-current', 'page');
  });
});
