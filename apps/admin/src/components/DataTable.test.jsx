import { render, screen, fireEvent, act } from '@testing-library/react';
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

describe('DataTable populated table', () => {
  const cols = [
    { header: 'Name', accessor: 'name' },
    { header: 'Role', accessor: 'role' },
    { header: 'Upper', render: (row) => row.name.toUpperCase() },
  ];
  const rows = [
    { id: 'a', name: 'Ada', role: 'admin' },
    { id: 'b', name: 'Bo', role: 'viewer' },
  ];

  it('renders a header cell per column and a row per record', () => {
    renderTable(<DataTable columns={cols} data={rows} />);

    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Name',
      'Role',
      'Upper',
    ]);
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByRole('cell', { name: 'Ada' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'viewer' })).toBeInTheDocument();
  });

  it('uses custom render functions for cell content', () => {
    renderTable(<DataTable columns={cols} data={rows} />);

    expect(screen.getByRole('cell', { name: 'ADA' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'BO' })).toBeInTheDocument();
  });

  it('marks every header cell with scope="col"', () => {
    renderTable(<DataTable columns={cols} data={rows} />);

    for (const th of screen.getAllByRole('columnheader')) {
      expect(th).toHaveAttribute('scope', 'col');
    }
  });

  it('falls back to the row index as key when keyField is missing on rows', () => {
    renderTable(<DataTable columns={cols} data={[{ name: 'X', role: 'r' }, { name: 'Y', role: 'r' }]} />);

    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('makes rows focusable and activates onRowClick with Enter, Space and click', async () => {
    const onRowClick = vi.fn();
    renderTable(<DataTable columns={cols} data={rows} onRowClick={onRowClick} />);

    const row = screen.getByRole('row', { name: 'View details for row 1' });
    expect(row).toHaveAttribute('tabindex', '0');

    await userEvent.click(row);
    row.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');

    expect(onRowClick).toHaveBeenCalledTimes(3);
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);
  });

  it('does not make rows focusable without onRowClick', () => {
    renderTable(<DataTable columns={cols} data={rows} />);

    expect(screen.queryByRole('row', { name: /View details/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('row')[1]).not.toHaveAttribute('tabindex');
  });
});

describe('DataTable Virtualization & Keyboard Navigation', () => {
  const virtCols = [
    { header: 'ID', accessor: 'id' },
    { header: 'Name', accessor: 'name' },
    { header: 'Value', accessor: 'value' },
  ];

  const generateData = (count) =>
    Array.from({ length: count }, (_, i) => ({
      id: `row-${i + 1}`,
      name: `User ${i + 1}`,
      value: (i + 1) * 10,
    }));

  it('renders standard table without virtualization when data is below threshold', () => {
    const data = generateData(20);
    renderTable(<DataTable columns={virtCols} data={data} virtualizeThreshold={50} />);

    const container = screen.getByTestId('datatable-container');
    expect(container).toHaveAttribute('data-virtualized', 'false');

    const dataRows = screen.getAllByRole('row').filter((r) => r.hasAttribute('data-row-index'));
    expect(dataRows).toHaveLength(20);
  });

  it('enables virtualization when data meets or exceeds threshold', () => {
    const data = generateData(150);
    renderTable(
      <DataTable
        columns={virtCols}
        data={data}
        virtualizeThreshold={50}
        rowHeight={50}
        maxHeight={500}
        overscan={3}
      />
    );

    const container = screen.getByTestId('datatable-container');
    expect(container).toHaveAttribute('data-virtualized', 'true');

    const dataRows = screen.getAllByRole('row').filter((r) => r.hasAttribute('data-row-index'));
    expect(dataRows.length).toBeLessThan(40);
    expect(dataRows.length).toBeGreaterThan(0);
  });

  it('virtualizes window correctly on scroll', () => {
    const data = generateData(200);
    renderTable(
      <DataTable
        columns={virtCols}
        data={data}
        virtualizeThreshold={50}
        rowHeight={50}
        maxHeight={500}
        overscan={2}
      />
    );

    const container = screen.getByTestId('datatable-container');

    expect(screen.getByText('User 1')).toBeInTheDocument();

    act(() => {
      fireEvent.scroll(container, { target: { scrollTop: 2500 } });
    });

    expect(screen.queryByText('User 1')).not.toBeInTheDocument();
    expect(screen.getByText('User 51')).toBeInTheDocument();
  });

  it('navigates rows seamlessly with ArrowDown, ArrowUp, Home, End', () => {
    const onRowClick = vi.fn();
    const data = generateData(100);
    renderTable(
      <DataTable
        columns={virtCols}
        data={data}
        onRowClick={onRowClick}
        virtualizeThreshold={50}
        rowHeight={50}
        maxHeight={400}
      />
    );

    const firstRow = screen.getByText('User 1').closest('tr');
    firstRow.focus();

    act(() => {
      fireEvent.keyDown(firstRow, { key: 'ArrowDown' });
    });
    const secondRow = screen.getByText('User 2').closest('tr');
    expect(secondRow).toHaveFocus();

    act(() => {
      fireEvent.keyDown(secondRow, { key: 'ArrowUp' });
    });
    expect(firstRow).toHaveFocus();

    act(() => {
      fireEvent.keyDown(firstRow, { key: 'End' });
    });
    const lastRow = screen.getByText('User 100').closest('tr');
    expect(lastRow).toBeInTheDocument();
    expect(lastRow).toHaveFocus();

    act(() => {
      fireEvent.keyDown(lastRow, { key: 'Home' });
    });
    const backToFirst = screen.getByText('User 1').closest('tr');
    expect(backToFirst).toBeInTheDocument();
    expect(backToFirst).toHaveFocus();

    act(() => {
      fireEvent.keyDown(backToFirst, { key: 'Enter' });
    });
    expect(onRowClick).toHaveBeenCalledWith(data[0]);
  });
});
