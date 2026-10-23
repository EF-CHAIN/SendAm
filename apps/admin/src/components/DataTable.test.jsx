import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

describe('DataTable column customization', () => {
  const cols = [
    { header: 'Name', accessor: 'name' },
    { header: 'Role', accessor: 'role' },
    { header: 'Status', accessor: 'status' },
  ];
  const rows = [
    { id: 'a', name: 'Ada', role: 'admin', status: 'active' },
    { id: 'b', name: 'Bo', role: 'viewer', status: 'idle' },
  ];

  const headerLabels = () =>
    screen.getAllByRole('columnheader').map((th) => th.textContent);

  const openCustomizer = () =>
    userEvent.click(screen.getByRole('button', { name: /customize columns/i }));

  beforeEach(() => {
    window.localStorage.clear();
  });

  it('renders the Customize Columns trigger and shows every column by default', () => {
    renderTable(<DataTable columns={cols} data={rows} storageKey="cols-default" />);

    expect(screen.getByRole('button', { name: /customize columns/i })).toBeInTheDocument();
    expect(headerLabels()).toEqual(['Name', 'Role', 'Status']);
  });

  it('hides a column immediately when its checkbox is unchecked', async () => {
    renderTable(<DataTable columns={cols} data={rows} storageKey="cols-hide" />);
    await openCustomizer();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Role' }));

    expect(headerLabels()).toEqual(['Name', 'Status']);
    expect(screen.queryByRole('cell', { name: 'viewer' })).not.toBeInTheDocument();
  });

  it('restores a hidden column when its checkbox is checked again', async () => {
    renderTable(<DataTable columns={cols} data={rows} storageKey="cols-restore" />);
    await openCustomizer();

    const roleCheckbox = screen.getByRole('checkbox', { name: 'Role' });
    await userEvent.click(roleCheckbox);
    expect(headerLabels()).toEqual(['Name', 'Status']);

    await userEvent.click(roleCheckbox);
    expect(headerLabels()).toEqual(['Name', 'Role', 'Status']);
  });

  it('reorders columns with the move controls', async () => {
    renderTable(<DataTable columns={cols} data={rows} storageKey="cols-order" />);
    await openCustomizer();

    await userEvent.click(screen.getByRole('button', { name: /move role up/i }));

    expect(headerLabels()).toEqual(['Role', 'Name', 'Status']);
  });

  it('keeps at least one column visible', async () => {
    renderTable(<DataTable columns={cols} data={rows} storageKey="cols-last" />);
    await openCustomizer();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Role' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Status' }));

    expect(screen.getByRole('checkbox', { name: 'Name' })).toBeDisabled();
    expect(headerLabels()).toEqual(['Name']);
  });

  it('persists preferences and restores them on remount', async () => {
    const { unmount } = renderTable(
      <DataTable columns={cols} data={rows} storageKey="cols-persist" />
    );
    await openCustomizer();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Role' }));
    expect(headerLabels()).toEqual(['Name', 'Status']);
    unmount();

    renderTable(<DataTable columns={cols} data={rows} storageKey="cols-persist" />);
    expect(headerLabels()).toEqual(['Name', 'Status']);
  });

  it('restores the default layout with the reset control', async () => {
    renderTable(<DataTable columns={cols} data={rows} storageKey="cols-reset" />);
    await openCustomizer();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Role' }));
    await userEvent.click(screen.getByRole('button', { name: /reset columns/i }));

    expect(headerLabels()).toEqual(['Name', 'Role', 'Status']);
    expect(screen.getByRole('checkbox', { name: 'Role' })).toBeChecked();
  });
});

describe('DataTable multi-column sorting', () => {
  const sortColumns = [
    { header: 'Status', accessor: 'status', sortable: true },
    { header: 'Date', accessor: 'date', sortable: true },
  ];
  const rows = [
    { id: 1, status: 'pending', date: '2026-01-02' },
    { id: 2, status: 'complete', date: '2026-01-03' },
    { id: 3, status: 'pending', date: '2026-01-01' },
    { id: 4, status: 'complete', date: '2026-01-01' },
  ];

  const dateOrderOf = () => Array.from(document.querySelectorAll('tbody tr[data-row-index]')).map((tr) => tr.querySelectorAll('td')[1].textContent);
  const statusOrderOf = () => Array.from(document.querySelectorAll('tbody tr[data-row-index]')).map((tr) => tr.querySelectorAll('td')[0].textContent);
  const header = (label) => screen.getByRole('button', { name: new RegExp(`^${label}`, 'i') });

  it('plain click sorts ascending, then flips to descending on the next click', async () => {
    const user = userEvent.setup();
    renderTable(<DataTable columns={sortColumns} data={rows} keyField="id" />);

    await user.click(header('Status'));
    expect(statusOrderOf()).toEqual(['complete', 'complete', 'pending', 'pending']);
    expect(screen.getByRole('columnheader', { name: /status/i })).toHaveAttribute('aria-sort', 'ascending');

    await user.click(header('Status'));
    expect(statusOrderOf()).toEqual(['pending', 'pending', 'complete', 'complete']);
    expect(screen.getByRole('columnheader', { name: /status/i })).toHaveAttribute('aria-sort', 'descending');
  });

  it('shift+click adds a secondary key and shows priority badges 1 and 2', async () => {
    const user = userEvent.setup();
    renderTable(<DataTable columns={sortColumns} data={rows} keyField="id" />);

    await user.click(header('Status'));
    await user.keyboard('{Shift>}');
    await user.click(header('Date'));
    await user.keyboard('{/Shift}');

    const badges = screen.getAllByTestId('sort-priority-badge').map((badge) => badge.textContent);
    expect(badges).toEqual(['1', '2']);
    // complete (2026-01-01 then 2026-01-03), then pending (2026-01-01 then 2026-01-02)
    expect(dateOrderOf()).toEqual(['2026-01-01', '2026-01-03', '2026-01-01', '2026-01-02']);
    expect(screen.getByRole('columnheader', { name: /date/i })).toHaveAttribute('aria-sort', 'ascending');
  });

  it('plain click after a multi-sort clears the secondary keys', async () => {
    const user = userEvent.setup();
    renderTable(<DataTable columns={sortColumns} data={rows} keyField="id" />);

    await user.click(header('Status'));
    await user.keyboard('{Shift>}');
    await user.click(header('Date'));
    await user.keyboard('{/Shift}');
    await user.click(header('Date'));

    expect(screen.queryByTestId('sort-priority-badge')).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /status/i })).toHaveAttribute('aria-sort', 'none');
    expect(screen.getByRole('columnheader', { name: /date/i })).toHaveAttribute('aria-sort', 'ascending');
  });

  it('shift+click on a sorted column flips its direction without adding a badge', async () => {
    const user = userEvent.setup();
    renderTable(<DataTable columns={sortColumns} data={rows} keyField="id" />);

    await user.click(header('Status'));
    await user.keyboard('{Shift>}');
    await user.click(header('Status'));
    await user.keyboard('{/Shift}');

    expect(screen.getByRole('columnheader', { name: /status/i })).toHaveAttribute('aria-sort', 'descending');
    expect(screen.queryByTestId('sort-priority-badge')).not.toBeInTheDocument();
  });

  it('accepts a multi-key defaultSort array', () => {
    renderTable(
      <DataTable
        columns={sortColumns}
        data={rows}
        keyField="id"
        defaultSort={[
          { key: 'status', direction: 'ascending' },
          { key: 'date', direction: 'descending' },
        ]}
      />
    );

    expect(statusOrderOf()).toEqual(['complete', 'complete', 'pending', 'pending']);
    expect(screen.getAllByTestId('sort-priority-badge').map((b) => b.textContent)).toEqual(['1', '2']);
    expect(screen.getByRole('columnheader', { name: /date/i })).toHaveAttribute('aria-sort', 'descending');
  });
});

describe('DataTable density', () => {
  const data = Array.from({ length: 200 }, (_, index) => ({ id: index + 1, name: `User ${index + 1}` }));
  const dataRows = () => Array.from(screen.getByRole('table').querySelectorAll('tr[data-row-index]'));
  const spacers = () => Array.from(screen.getByRole('table').querySelectorAll('tbody tr[aria-hidden="true"]'));

  it('provides accessible density controls and updates padding, font size and row height', async () => {
    renderTable(<DataTable columns={columns} data={data.slice(0, 2)} />);

    expect(screen.getByRole('group', { name: 'Table density' })).toBeInTheDocument();
    const cases = [
      ['Default', 'py-3', 'text-sm', '45px'],
      ['Compact', 'py-1', 'text-xs', '25px'],
      ['Comfortable', 'py-5', 'text-base', '65px'],
      ['Default', 'py-3', 'text-sm', '45px'],
    ];
    for (const [label, padding, font, height] of cases) {
      const button = screen.getByRole('button', { name: label });
      await userEvent.click(button);
      expect(button).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getAllByRole('button').filter((item) => item.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
      for (const row of dataRows()) {
        expect(row).toHaveStyle({ height });
        for (const cell of row.querySelectorAll('td')) {
          expect(cell).toHaveClass(padding, font);
        }
      }
      expect(button).toHaveFocus();
    }
  });

  it('keeps the same scroll anchor and synchronized virtual spacers in every density', async () => {
    renderTable(<DataTable columns={columns} data={data} maxHeight={300} overscan={2} />);
    const container = screen.getByTestId('datatable-container');
    fireEvent.scroll(container, { target: { scrollTop: 900 } });

    for (const [label, height] of [['Compact', 25], ['Comfortable', 65], ['Default', 45]]) {
      await userEvent.click(screen.getByRole('button', { name: label }));
      const rows = dataRows();
      expect(container.scrollTop).toBe(20 * height);
      expect(Number(rows[0].dataset.rowIndex)).toBe(18);
      expect(screen.getByText('User 21')).toBeInTheDocument();
      expect(spacers()[0]).toHaveStyle({ height: `${18 * height}px` });
      const lastIndex = Number(rows.at(-1).dataset.rowIndex);
      expect(spacers()[1]).toHaveStyle({ height: `${(199 - lastIndex) * height}px` });
      expect(rows.length).toBeLessThan(20);
      expect(spacers().reduce((sum, spacer) => sum + parseFloat(spacer.style.height), 0) + rows.length * height).toBe(200 * height);
    }
  });

  it('clamps the virtual window when shrinking density at the end of the table', async () => {
    renderTable(<DataTable columns={columns} data={data} maxHeight={300} overscan={0} />);
    const container = screen.getByTestId('datatable-container');
    await userEvent.click(screen.getByRole('button', { name: 'Comfortable' }));
    fireEvent.scroll(container, { target: { scrollTop: 200 * 65 + 49 - 300 } });
    await userEvent.click(screen.getByRole('button', { name: 'Compact' }));

    expect(container.scrollTop).toBe(200 * 25 + 49 - 300);
    expect(screen.getByText('User 200')).toBeInTheDocument();
    expect(dataRows().length).toBeGreaterThan(1);
    expect(spacers()).toHaveLength(1);
  });

  it.each([
    ['plain rows', 45, 65, 26],
    ['rich rows', 49, 67, 33],
  ])('keeps the bottom edge pinned when first Compact measurements settle for %s', async (_, defaultHeight, comfortableHeight, compactHeight) => {
    const observers = [];
    const OriginalResizeObserver = global.ResizeObserver;
    global.ResizeObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.targets = [];
        observers.push(this);
      }
      observe(target) { this.targets.push(target); }
      disconnect() { this.disconnected = true; }
    };
    try {
      renderTable(<DataTable columns={columns} data={data} maxHeight={400} overscan={2} />);
      const container = screen.getByTestId('datatable-container');
      const measureRows = (height) => {
        const observer = observers.findLast((item) =>
          !item.disconnected && item.targets.some((target) => target.hasAttribute('data-row-index'))
        );
        act(() => observer.callback(observer.targets.map((target) => ({
          target, borderBoxSize: [{ blockSize: height }], contentRect: { height },
        }))));
      };
      measureRows(defaultHeight);
      await userEvent.click(screen.getByRole('button', { name: 'Comfortable' }));
      measureRows(comfortableHeight);
      fireEvent.keyDown(screen.getByText('User 1').closest('tr'), { key: 'End' });
      fireEvent.scroll(container);
      expect(container.scrollTop).toBe(200 * comfortableHeight + 49 - 400);

      await userEvent.click(screen.getByRole('button', { name: 'Compact' }));
      // Native scrolling fires before ResizeObserver corrects the first estimate.
      fireEvent.scroll(container);
      measureRows(compactHeight);
      expect(container.scrollTop).toBe(200 * compactHeight + 49 - 400);
      expect(screen.getByText('User 200')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Compact' })).toHaveFocus();
      for (const [label, height] of [['Comfortable', comfortableHeight], ['Default', defaultHeight], ['Compact', compactHeight]]) {
        await userEvent.click(screen.getByRole('button', { name: label }));
        fireEvent.scroll(container);
        expect(container.scrollTop).toBe(200 * height + 49 - 400);
        expect(screen.getByText('User 200')).toBeInTheDocument();
      }

      // Later manual scrolling must release the bottom anchor.
      fireEvent.scroll(container, { target: { scrollTop: 20 * compactHeight } });
      await userEvent.click(screen.getByRole('button', { name: 'Default' }));
      expect(container.scrollTop).toBe(20 * defaultHeight);
      expect(screen.getByText('User 21')).toBeInTheDocument();
    } finally {
      global.ResizeObserver = OriginalResizeObserver;
    }
  });

  it('uses the active row height and sticky header for keyboard scrolling without stealing control focus', async () => {
    const onRowClick = vi.fn();
    renderTable(<DataTable columns={columns} data={data} maxHeight={300} overscan={0} onRowClick={onRowClick} />);
    const container = screen.getByTestId('datatable-container');
    const firstRow = screen.getByText('User 1').closest('tr');
    fireEvent.keyDown(firstRow, { key: 'ArrowDown' });
    expect(screen.getByText('User 2').closest('tr')).toHaveFocus();

    const compact = screen.getByRole('button', { name: 'Compact' });
    await userEvent.click(compact);
    expect(compact).toHaveFocus();
    fireEvent.keyDown(screen.getByText('User 2').closest('tr'), { key: 'End' });
    const lastRow = screen.getByText('User 200').closest('tr');
    expect(lastRow).toHaveFocus();
    expect(container.scrollTop).toBe(200 * 25 + 49 - 300);
    fireEvent.keyDown(lastRow, { key: 'Enter' });
    expect(onRowClick).toHaveBeenCalledWith(data[199]);
    fireEvent.keyDown(lastRow, { key: 'Home' });
    expect(screen.getByText('User 1').closest('tr')).toHaveFocus();
    expect(container.scrollTop).toBe(0);
  });

  it('allows the browser to reveal keyboard targets in a nonvirtualized table', () => {
    renderTable(<DataTable columns={columns} data={data.slice(0, 20)} onRowClick={vi.fn()} />);
    const lastRow = screen.getByText('User 20').closest('tr');
    const focus = vi.spyOn(lastRow, 'focus');
    fireEvent.keyDown(screen.getByText('User 1').closest('tr'), { key: 'End' });
    expect(lastRow).toHaveFocus();
    expect(focus).toHaveBeenCalledWith({ preventScroll: false });
  });

  it('preserves sorting, custom cell selection and URL filters without rerendering the data owner', async () => {
    const renderOwner = vi.fn();
    const selectableColumns = [
      { header: 'Name', accessor: 'name', sortable: true },
      { header: 'Selected', render: (row) => <input type="checkbox" aria-label={`Select ${row.name}`} /> },
    ];
    function Owner() {
      renderOwner();
      return <DataTable columns={selectableColumns} data={data.slice(0, 3)} />;
    }
    renderTable(<Owner />, ['/users?phone=555&limit=50']);
    await userEvent.click(screen.getByRole('button', { name: 'Name' }));
    await userEvent.click(screen.getByRole('button', { name: 'Name' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select User 2' }));
    const rendersBeforeDensity = renderOwner.mock.calls.length;

    for (const label of ['Compact', 'Comfortable', 'Default']) {
      await userEvent.click(screen.getByRole('button', { name: label }));
      expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'descending');
      expect(dataRows().map((row) => row.cells[0].textContent)).toEqual(['User 3', 'User 2', 'User 1']);
      expect(screen.getByRole('checkbox', { name: 'Select User 2' })).toBeChecked();
      expect(screen.getByTestId('location-search')).toHaveTextContent('?phone=555&limit=50');
      expect(renderOwner).toHaveBeenCalledTimes(rendersBeforeDensity);
    }
  });

  it('observes taller custom rows in a batch and preserves the anchor as their height settles', async () => {
    const observers = [];
    const OriginalResizeObserver = global.ResizeObserver;
    global.ResizeObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.targets = [];
        observers.push(this);
      }
      observe(target) { this.targets.push(target); }
      disconnect() { this.disconnected = true; }
    };
    try {
      renderTable(<DataTable columns={columns} data={data} maxHeight={300} overscan={2} />);
      const container = screen.getByTestId('datatable-container');
      fireEvent.scroll(container, { target: { scrollTop: 900 } });
      const observeRows = () => observers.findLast((observer) =>
        !observer.disconnected && observer.targets.some((target) => target.hasAttribute('data-row-index'))
      );
      const measureRows = (heights) => {
        const observer = observeRows();
        act(() => observer.callback(heights.map((height, index) => ({
          target: observer.targets[index],
          borderBoxSize: [{ blockSize: height }],
          contentRect: { height: height - 1 },
        }))));
      };

      measureRows([45, 61.25, 50]);
      expect(container.scrollTop).toBe(20 * 62);
      expect(dataRows()[0]).toHaveStyle({ height: '62px' });
      expect(spacers()[0]).toHaveStyle({ height: `${18 * 62}px` });
      measureRows([62, 62, 62]);
      expect(container.scrollTop).toBe(20 * 62);
      expect(dataRows()[0]).toHaveStyle({ height: '62px' });

      await userEvent.click(screen.getByRole('button', { name: 'Compact' }));
      expect(dataRows()[0]).toHaveStyle({ height: '25px' });
      measureRows([33, 25]);
      expect(container.scrollTop).toBe(20 * 33);
      expect(dataRows()[0]).toHaveStyle({ height: '33px' });
      expect(observeRows().targets.every((row) => row.hasAttribute('data-row-index'))).toBe(true);
      await userEvent.click(screen.getByRole('button', { name: 'Default' }));
      expect(dataRows()[0]).toHaveStyle({ height: '62px' });
      expect(container.scrollTop).toBe(20 * 62);
    } finally {
      global.ResizeObserver = OriginalResizeObserver;
    }
  });

  it('starts measuring the viewport and header when initially empty data arrives', () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    const callbacks = [];
    const OriginalResizeObserver = global.ResizeObserver;
    global.ResizeObserver = class {
      constructor(callback) { callbacks.push(callback); }
      observe = observe;
      disconnect = disconnect;
    };
    try {
      const { rerender, unmount } = renderTable(<DataTable columns={columns} data={[]} />);
      expect(observe).not.toHaveBeenCalled();
      rerender(<MemoryRouter><DataTable columns={columns} data={data} maxHeight={300} /></MemoryRouter>);
      const container = screen.getByTestId('datatable-container');
      const header = screen.getByRole('table').querySelector('thead');
      expect(observe).toHaveBeenCalledWith(container);
      expect(observe).toHaveBeenCalledWith(header);
      act(() => callbacks[0]([
        { target: container, contentRect: { height: 250 } },
        { target: header, contentRect: { height: 55 }, borderBoxSize: [{ blockSize: 56 }] },
      ]));
      fireEvent.keyDown(screen.getByText('User 1').closest('tr'), { key: 'End' });
      expect(container.scrollTop).toBe(200 * 45 + 56 - 250);
      expect(screen.getByText('User 200').closest('tr')).toHaveFocus();
      unmount();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      global.ResizeObserver = OriginalResizeObserver;
    }
  });

  it('adjusts an explicit Default rowHeight for the selected density', async () => {
    renderTable(<DataTable columns={columns} data={data} rowHeight={50} maxHeight={300} />);
    const container = screen.getByTestId('datatable-container');
    fireEvent.scroll(container, { target: { scrollTop: 1000 } });
    for (const [label, height] of [['Compact', 30], ['Comfortable', 70], ['Default', 50]]) {
      await userEvent.click(screen.getByRole('button', { name: label }));
      expect(container.scrollTop).toBe(20 * height);
      expect(dataRows()[0]).toHaveStyle({ height: `${height}px` });
    }
  });
});
