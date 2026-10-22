import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AdminSidebar from './AdminSidebar';
import { getAdminMe, getAdminKyc } from '@/lib/adminApi';

vi.mock('@/lib/adminApi', () => ({
  getAdminMe: vi.fn().mockResolvedValue({ permissions: ['admin.read', 'compliance.read'] }),
  getAdminKyc: vi.fn().mockResolvedValue({ pagination: { total: 0 }, data: [] }),
}));

const renderAt = (route, props = {}) =>
  render(
    <MemoryRouter initialEntries={[route]}>
      <AdminSidebar {...props} />
    </MemoryRouter>
  );

describe('AdminSidebar aria-current', () => {
  it.each([
    ['/', 'Overview'],
    ['/users', 'Users'],
    ['/transactions', 'Transactions'],
  ])('marks only the %s link as the current page', async (route, name) => {
    renderAt(route);
    const active = await screen.findByRole('link', { name });
    expect(active).toHaveAttribute('aria-current', 'page');

    const others = screen.getAllByRole('link').filter((l) => l !== active);
    expect(others.length).toBeGreaterThan(0);
    others.forEach((l) => expect(l).not.toHaveAttribute('aria-current'));
  });
});

describe('AdminSidebar KYC pending counter badge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAdminMe.mockResolvedValue({ permissions: ['admin.read', 'compliance.read'] });
    getAdminKyc.mockResolvedValue({ pagination: { total: 0 }, data: [] });
  });

  it('renders KYC link with accessible name "KYC" without badge when pending count is 0', async () => {
    renderAt('/', { pendingKycCount: 0 });
    const kycLink = await screen.findByRole('link', { name: 'KYC' });
    expect(kycLink).toBeInTheDocument();
    expect(screen.queryByTestId('kyc-counter-badge')).not.toBeInTheDocument();
    expect(kycLink).not.toHaveAttribute('aria-describedby');
  });

  it('displays amber counter badge and screen-reader announcement when pendingKycCount > 0', async () => {
    renderAt('/', { pendingKycCount: 5 });
    const kycLink = await screen.findByRole('link', { name: 'KYC' });
    expect(kycLink).toBeInTheDocument();

    const badge = screen.getByTestId('kyc-counter-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('5');
    expect(badge).toHaveAttribute('aria-hidden', 'true');
    expect(badge.className).toContain('bg-amber-100');
    expect(badge.className).toContain('text-amber-900');

    expect(kycLink).toHaveAttribute('aria-describedby', 'kyc-pending-count');
    const srDescription = document.getElementById('kyc-pending-count');
    expect(srDescription).toBeInTheDocument();
    expect(srDescription).toHaveTextContent('5 pending verification submissions');
    expect(srDescription.className).toContain('sr-only');
  });

  it('fetches pending count via getAdminKyc polling when pendingKycCount prop is omitted', async () => {
    getAdminKyc.mockResolvedValueOnce({ pagination: { total: 12 }, data: [] });
    renderAt('/');

    const kycLink = await screen.findByRole('link', { name: 'KYC' });
    expect(kycLink).toBeInTheDocument();

    const badge = await screen.findByTestId('kyc-counter-badge');
    expect(badge).toHaveTextContent('12');
    expect(getAdminKyc).toHaveBeenCalledWith({ status: 'pending', limit: 1 });
  });

  it('triggers pulse animation when pending KYC count increases', async () => {
    const { rerender } = render(
      <MemoryRouter initialEntries={['/']}>
        <AdminSidebar pendingKycCount={2} />
      </MemoryRouter>
    );

    const badge = await screen.findByTestId('kyc-counter-badge');
    expect(badge).toHaveTextContent('2');
    expect(badge.className).not.toContain('animate-pulse');

    // Increase count
    rerender(
      <MemoryRouter initialEntries={['/']}>
        <AdminSidebar pendingKycCount={6} />
      </MemoryRouter>
    );

    const updatedBadge = screen.getByTestId('kyc-counter-badge');
    expect(updatedBadge).toHaveTextContent('6');
    expect(updatedBadge.className).toContain('animate-pulse');
    expect(updatedBadge.className).toContain('scale-110');
  });

  it('hides badge when count transitions back to 0', async () => {
    const { rerender } = render(
      <MemoryRouter initialEntries={['/']}>
        <AdminSidebar pendingKycCount={3} />
      </MemoryRouter>
    );

    expect(await screen.findByTestId('kyc-counter-badge')).toBeInTheDocument();

    rerender(
      <MemoryRouter initialEntries={['/']}>
        <AdminSidebar pendingKycCount={0} />
      </MemoryRouter>
    );

    expect(screen.queryByTestId('kyc-counter-badge')).not.toBeInTheDocument();
  });
});

