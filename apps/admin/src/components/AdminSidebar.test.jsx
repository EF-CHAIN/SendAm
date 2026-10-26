import { useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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


describe('AdminSidebar mobile drawer', () => {
  let media;
  let resize;
  beforeEach(() => {
    getAdminMe.mockResolvedValue({ permissions: ['admin.read'] });
    if (!HTMLDialogElement.prototype.showModal) HTMLDialogElement.prototype.showModal = function () {};
    if (!HTMLDialogElement.prototype.close) HTMLDialogElement.prototype.close = function () {};
    media = { matches: false, addEventListener: vi.fn((_, handler) => { resize = handler; }), removeEventListener: vi.fn() };
    vi.stubGlobal('matchMedia', vi.fn(() => media));
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function () { this.setAttribute('open', ''); });
    vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function () { this.removeAttribute('open'); });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.style.overflow = ''; });

  function Harness({ search = () => {} }) {
    const [open, setOpen] = useState(false);
    return <MemoryRouter><button onClick={() => setOpen(true)}>Menu</button><AdminSidebar isOpen={open} onClose={() => setOpen(false)} onOpenSearch={search} /></MemoryRouter>;
  }
  const open = () => fireEvent.click(screen.getByRole('button', { name: 'Menu' }));

  it('hides navigation until opened, locks scrolling and closes on route selection', async () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    open();
    expect(screen.getByRole('dialog', { name: 'Admin Panel' })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(await screen.findByRole('link', { name: 'Users' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
  });

  it('preserves the live KYC badge and closes when its link is selected', async () => {
    getAdminMe.mockResolvedValue({ permissions: ['admin.read', 'compliance.read'] });
    getAdminKyc.mockResolvedValue({ pagination: { total: 7 }, data: [] });
    render(<Harness />); open();
    expect(await screen.findByTestId('kyc-counter-badge')).toHaveTextContent('7');
    const link = screen.getByRole('link', { name: 'KYC' });
    expect(link).toHaveAccessibleDescription('7 pending verification submissions');
    fireEvent.click(link);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
  });

  it('also closes when selecting the current route', async () => {
    render(<Harness />); open();
    fireEvent.click(await screen.findByRole('link', { name: 'Overview' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes with close button, Escape cancellation and backdrop clicks', () => {
    render(<Harness />); open();
    fireEvent.click(screen.getByRole('button', { name: 'Close navigation' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    open();
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: false, cancelable: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    open();
    const dialog = screen.getByRole('dialog');
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 288, top: 0, bottom: 800 });
    fireEvent.click(dialog, { clientX: 100, clientY: 100 });
    expect(dialog).toHaveAttribute('open');
    fireEvent.click(dialog, { clientX: 350, clientY: 100 });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes only on a deliberate left swipe, not vertical scrolling or right swipes', () => {
    render(<Harness />); open();
    const dialog = screen.getByRole('dialog');
    for (const [x, y] of [[250, 10], [100, 200], [170, 10]]) {
      fireEvent.touchStart(dialog, { touches: [{ clientX: 200, clientY: 10 }] });
      fireEvent.touchEnd(dialog, { changedTouches: [{ clientX: x, clientY: y }] });
      expect(dialog).toHaveAttribute('open');
    }
    fireEvent.touchStart(dialog, { touches: [{ clientX: 200, clientY: 10 }] });
    fireEvent.touchEnd(dialog, { changedTouches: [{ clientX: 80, clientY: 15 }] });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes before opening global search', () => {
    const search = vi.fn(); render(<Harness search={search} />); open();
    fireEvent.click(screen.getByTestId('sidebar-search-btn'));
    expect(search).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('restores previous scrolling on unmount', () => {
    document.body.style.overflow = 'auto';
    const { unmount } = render(<Harness />); open(); unmount();
    expect(document.body.style.overflow).toBe('auto');
  });

  it('cleans up the modal when resized to desktop and keeps it closed when returning to mobile', async () => {
    render(<Harness />); open();
    await screen.findByRole('link', { name: 'Users' });
    act(() => resize({ matches: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Admin navigation' })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
    act(() => resize({ matches: false }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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

