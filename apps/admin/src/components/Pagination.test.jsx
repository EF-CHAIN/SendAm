import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import Pagination from './Pagination';
import { useListQuery } from '@/lib/useListQuery';

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

// Three keyset pages of 50 rows out of `total: 120` → totalPages 3. The
// harness stands in for a list page: useListQuery owns the URL (cursors +
// page counter) and the matching page object is derived synchronously from
// those params — no fetch, no setState-in-effect.
const PAGES = {
  1: { prevCursor: null, nextCursor: 'c1' },
  2: { prevCursor: 'c2', nextCursor: 'c3' },
  3: { prevCursor: 'c4', nextCursor: null },
};

function PagerHarness() {
  const { page, goNext, goPrev } = useListQuery([]);
  const entry = PAGES[page] || PAGES[1];
  const pagination = {
    limit: 50,
    total: 120,
    hasMore: Boolean(entry.nextCursor),
    prevCursor: entry.prevCursor,
    nextCursor: entry.nextCursor,
  };
  return <Pagination pagination={pagination} onNext={goNext} onPrev={goPrev} />;
}

const renderHarness = (url = '/') => render(
  <MemoryRouter initialEntries={[url]}>
    <PagerHarness />
    <CurrentSearch />
  </MemoryRouter>
);

const currentQuery = () => new URLSearchParams(screen.getByTestId('search').textContent);

describe('Pagination jump-to-page (#753)', () => {
  it('binds the input to the page count derived from total and page size', async () => {
    renderHarness();
    const input = await screen.findByTestId('jump-to-page');
    expect(screen.getByLabelText('Go to page')).toBe(input);
    expect(input).toHaveAttribute('min', '1');
    expect(input).toHaveAttribute('max', '3'); // total 120 / size 50
    expect(input).toHaveValue(1);
  });

  it('walks to the entered page and lands on it', async () => {
    renderHarness();
    const input = await screen.findByTestId('jump-to-page');
    await userEvent.clear(input);
    await userEvent.type(input, '3');
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));

    await waitFor(() => expect(input).toHaveValue(3));
    expect(currentQuery().get('page')).toBe('3');
    expect(currentQuery().get('after')).toBe('c3');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clamps a target beyond the last page and flags the input', async () => {
    renderHarness();
    const input = await screen.findByTestId('jump-to-page');
    await userEvent.clear(input);
    await userEvent.type(input, '99');
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));

    await waitFor(() => expect(input).toHaveValue(3));
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Page out of range — clamped to 1–3.');

    // Editing the field clears the error state again.
    await userEvent.type(input, '2');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clamps a target below the first page without navigating', async () => {
    renderHarness();
    const input = await screen.findByTestId('jump-to-page');
    fireEvent.change(input, { target: { value: '-5' } });
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));

    expect(input).toHaveValue(1);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Page out of range — clamped to 1–3.');
    expect(currentQuery().has('page')).toBe(false);
    expect(currentQuery().has('after')).toBe(false);
  });

  it('tracks the page counter in the URL across manual Next/Prev', async () => {
    renderHarness();
    await screen.findByTestId('jump-to-page');

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(currentQuery().get('page')).toBe('2'));
    expect(screen.getByTestId('jump-to-page')).toHaveValue(2);

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(currentQuery().get('page')).toBe('3'));

    await userEvent.click(screen.getByRole('button', { name: 'Prev' }));
    await waitFor(() => expect(currentQuery().get('page')).toBe('2'));

    await userEvent.click(screen.getByRole('button', { name: 'Prev' }));
    await waitFor(() => expect(currentQuery().has('page')).toBe(false));
    expect(screen.getByTestId('jump-to-page')).toHaveValue(1);
  });
});
