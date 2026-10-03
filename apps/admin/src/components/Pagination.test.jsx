import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import Pagination from './Pagination';

function CurrentSearch() {
  const location = useLocation();
  return <output data-testid="search">{location.search}</output>;
}

const pagination = { limit: 50, total: 120, hasMore: true, nextCursor: 'next', prevCursor: 'prev' };

describe('Pagination', () => {
  it('offers the supported sizes and uses the API default', () => {
    render(<MemoryRouter><Pagination pagination={pagination} /></MemoryRouter>);
    const selector = screen.getByRole('combobox', { name: 'Items per page' });
    expect(selector).toHaveValue('50');
    expect(Array.from(selector.options, (option) => option.value)).toEqual(['10', '25', '50', '100']);
  });

  it('keeps filters and clears both cursor directions when size changes', async () => {
    const onNext = vi.fn();
    render(
      <MemoryRouter initialEntries={['/transactions?status=success&after=old&before=older&limit=25']}>
        <Pagination pagination={pagination} onNext={onNext} />
        <CurrentSearch />
      </MemoryRouter>
    );

    const selector = screen.getByRole('combobox', { name: 'Items per page' });
    expect(selector).toHaveValue('25');
    await userEvent.selectOptions(selector, '100');

    const query = new URLSearchParams(screen.getByTestId('search').textContent);
    expect(query.get('status')).toBe('success');
    expect(query.get('limit')).toBe('100');
    expect(query.has('after')).toBe(false);
    expect(query.has('before')).toBe(false);
    expect(onNext).not.toHaveBeenCalled();
  });
});
