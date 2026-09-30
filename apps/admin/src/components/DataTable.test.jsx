import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import DataTable from './DataTable';

const columns = [{ header: 'Name', accessor: 'name' }];

/** Exposes the current URL search string so tests can assert on resets. */
function LocationProbe() {
  const { search } = useLocation();
  return <span data-testid="location-search">{search}</span>;
}

function renderTable(ui, initialEntries = ['/']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      {ui}
      <LocationProbe />
    </MemoryRouter>
  );
}

describe('DataTable empty state', () => {
  it('shows the default message without a reset button when no filters are active', () => {
    renderTable(<DataTable columns={columns} data={[]} />);

    expect(screen.getByText('No records found.')).toBeInTheDocument();
    expect(screen.getByText(/no records to show right now/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reset filters/i })).not.toBeInTheDocument();
  });

  it('offers a one-click reset when filters caused the empty state', async () => {
    renderTable(<DataTable columns={columns} data={[]} />, ['/users?phone=555&after=cursor']);

    expect(screen.getByText(/current search or filters/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /reset filters/i }));

    // Filters and the stale cursor are cleared from the URL, which also
    // removes the reset action itself.
    expect(screen.getByTestId('location-search').textContent).toBe('');
    expect(screen.queryByRole('button', { name: /reset filters/i })).not.toBeInTheDocument();
  });

  it('does not treat pagination cursors alone as active filters', () => {
    renderTable(<DataTable columns={columns} data={[]} />, ['/users?after=abc&limit=50']);

    expect(screen.getByText(/no records to show right now/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reset filters/i })).not.toBeInTheDocument();
  });

  it('renders a custom emptyState title, description and icon', () => {
    const CustomIcon = () => <svg data-testid="custom-icon" />;
    renderTable(
      <DataTable
        columns={columns}
        data={[]}
        emptyState={{ title: 'Nothing here', description: 'Custom explanation.', icon: CustomIcon }}
      />,
      ['/users?phone=555']
    );

    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.getByText('Custom explanation.')).toBeInTheDocument();
    expect(screen.getByTestId('custom-icon')).toBeInTheDocument();
    // Custom copy wins, but the reset action still works.
    expect(screen.getByRole('button', { name: /reset filters/i })).toBeInTheDocument();
  });

  it('prefers the onResetFilters callback over clearing the URL', async () => {
    const onResetFilters = vi.fn();
    renderTable(
      <DataTable columns={columns} data={[]} onResetFilters={onResetFilters} />,
      ['/users?phone=555']
    );

    await userEvent.click(screen.getByRole('button', { name: /reset filters/i }));

    expect(onResetFilters).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('location-search').textContent).toBe('?phone=555');
  });
});
