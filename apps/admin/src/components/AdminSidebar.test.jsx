import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import AdminSidebar from './AdminSidebar';

vi.mock('@/lib/adminApi', () => ({
  getAdminMe: vi.fn().mockResolvedValue({ permissions: ['admin.read'] }),
}));

const renderAt = (route) =>
  render(
    <MemoryRouter initialEntries={[route]}>
      <AdminSidebar />
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
