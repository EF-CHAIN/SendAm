import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, it, expect, vi } from 'vitest';
import FilterBar from './FilterBar';
import { useListQuery } from '@/lib/useListQuery';

const testFields = [
  { key: 'phone', label: 'Phone', placeholder: '+234...' },
  { key: 'status', label: 'Status', type: 'select', options: ['pending', 'success', 'failed'] },
  { key: 'from', label: 'From', type: 'date' },
];

const renderFilterBar = () => {
  const values = { phone: '', status: '', from: '' };
  const setFilter = vi.fn();
  const onReset = vi.fn();
  const utils = render(
    <FilterBar
      fields={testFields}
      getFilter={(key) => values[key]}
      setFilter={setFilter}
      onReset={onReset}
    />
  );
  return { ...utils, setFilter, onReset };
};

describe('FilterBar accessibility and interactions', () => {
  it('exposes a search landmark with an accessible label for assistive tech', () => {
    renderFilterBar();
    expect(screen.getByRole('search', { name: 'Filter controls' })).toBeInTheDocument();
  });

  it('gives the text filter an accessible name from its label', () => {
    renderFilterBar();
    expect(screen.getByRole('textbox', { name: 'Phone' })).toBeInTheDocument();
  });

  it('names the select filter by its label alone, not its selected option', () => {
    renderFilterBar();
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveAccessibleName('Status');
  });

  it('gives non-text inputs an accessible name from their label', () => {
    renderFilterBar();
    expect(screen.getByLabelText('From')).toHaveAccessibleName('From');
  });

  it('gives every interactive control a programmatically-determinable name', () => {
    const { container } = renderFilterBar();
    const controls = container.querySelectorAll('input, select, button');
    // One control per field, plus the Reset button.
    expect(controls).toHaveLength(testFields.length + 1);
    controls.forEach((control) => {
      expect(control).toHaveAccessibleName();
    });
    testFields.forEach((field) => {
      expect(screen.getByTestId(`filter-${field.key}`)).toHaveAccessibleName(field.label);
    });
  });

  it('explicitly associates each label with a uniquely-identified control', () => {
    renderFilterBar();
    renderFilterBar();
    const phones = screen.getAllByRole('textbox', { name: 'Phone' });
    expect(phones).toHaveLength(2);
    expect(phones[0].id).not.toBe(phones[1].id);
    phones.forEach((input) => {
      expect(document.querySelector(`label[for="${CSS.escape(input.id)}"]`)).toHaveTextContent('Phone');
    });
  });

  it('forwards changes and resets through the provided callbacks', async () => {
    const user = userEvent.setup();
    const { setFilter, onReset } = renderFilterBar();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'failed');
    expect(setFilter).toHaveBeenCalledWith('status', 'failed');

    await user.type(screen.getByRole('textbox', { name: 'Phone' }), '1');
    // Typed filters commit on the debounce, not per keystroke (#750).
    await waitFor(() => expect(setFilter).toHaveBeenCalledWith('phone', '1'));

    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});

const chipFields = [
  { key: 'status', label: 'Status', type: 'select', options: ['failed', 'success'] },
  { key: 'asset', label: 'Asset', placeholder: 'Asset' },
];

function Harness() {
  const { getFilter, setFilter, resetFilters } = useListQuery(['status', 'asset']);
  return <FilterBar fields={chipFields} getFilter={getFilter} setFilter={setFilter} onReset={resetFilters} />;
}

const renderAt = (url) => render(
  <MemoryRouter initialEntries={[url]}>
    <Harness />
  </MemoryRouter>
);

describe('FilterBar debounced search (#750)', () => {
  it('holds the query back until typing pauses for 300ms', async () => {
    const { setFilter } = renderFilterBar();
    const user = userEvent.setup();

    await user.type(screen.getByRole('textbox', { name: 'Phone' }), '12', { delay: 40 });
    // Still inside the quiet window — nothing has reached the query yet.
    expect(setFilter).not.toHaveBeenCalled();

    // One commit for the whole burst, carrying only the final value.
    await waitFor(() => expect(setFilter).toHaveBeenCalledWith('phone', '12'));
    expect(setFilter).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending keystroke when the filter is cleared externally', async () => {
    renderAt('/?asset=XLM');
    const user = userEvent.setup();
    const input = screen.getByRole('textbox', { name: 'Asset' });

    await user.type(input, '999', { delay: 40 }); // commit timer still pending
    await user.click(screen.getByRole('button', { name: 'Clear Asset filter' }));
    expect(input).toHaveValue('');

    // If the pending timer still fired, the URL would regain the keystrokes
    // and the draft would re-sync to them a moment later.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(input).toHaveValue('');
  });
});

describe('FilterBar active filter chips', () => {
  it('renders no chips when nothing is filtered', () => {
    renderAt('/');
    expect(screen.queryByLabelText('Active filters')).not.toBeInTheDocument();
    expect(screen.queryByText('Clear All')).not.toBeInTheDocument();
  });

  it('shows a labelled chip and no Clear All for a single filter', () => {
    renderAt('/?status=failed');
    expect(screen.getByText('Status: failed')).toBeInTheDocument();
    expect(screen.queryByText('Clear All')).not.toBeInTheDocument();
  });

  it('clears only that filter when a chip is dismissed', async () => {
    renderAt('/?status=failed&asset=XLM');
    await userEvent.click(screen.getByRole('button', { name: 'Clear Status filter' }));
    expect(screen.queryByText('Status: failed')).not.toBeInTheDocument();
    expect(screen.getByText('Asset: XLM')).toBeInTheDocument();
    expect(screen.getByTestId('filter-status')).toHaveValue('');
  });

  it('shows Clear All for two or more filters and clears everything', async () => {
    renderAt('/?status=failed&asset=XLM');
    await userEvent.click(screen.getByText('Clear All'));
    expect(screen.queryByLabelText('Active filters')).not.toBeInTheDocument();
    expect(screen.getByTestId('filter-asset')).toHaveValue('');
  });
});

describe('FilterBar date presets', () => {
  const rangeFields = [
    { key: 'phone', label: 'Phone' },
    { key: 'from', label: 'From', type: 'date' },
    { key: 'to', label: 'To', type: 'date' },
  ];

  const renderWithRange = (values = { phone: '', from: '', to: '' }) => {
    const setFilter = vi.fn();
    const utils = render(
      <FilterBar
        fields={rangeFields}
        getFilter={(key) => values[key]}
        setFilter={setFilter}
        onReset={vi.fn()}
      />
    );
    return { ...utils, setFilter };
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the five quick ranges only when the bar has a from/to date pair', () => {
    renderWithRange();
    const group = screen.getByRole('group', { name: 'Quick date ranges' });
    for (const label of ['Today', 'Yesterday', 'Last 7 Days', 'Month to Date', 'Year to Date']) {
      expect(within(group).getByRole('button', { name: label })).toBeInTheDocument();
    }

    cleanup();
    renderFilterBar(); // single date field: no preset row
    expect(screen.queryByRole('group', { name: 'Quick date ranges' })).not.toBeInTheDocument();
  });

  it.each([
    ['Today', '2026-10-19', '2026-10-19'],
    ['Yesterday', '2026-10-18', '2026-10-18'],
    ['Last 7 Days', '2026-10-13', '2026-10-19'],
    ['Month to Date', '2026-10-01', '2026-10-19'],
    ['Year to Date', '2026-01-01', '2026-10-19'],
  ])('%s fills both ISO bounds in one click', async (label, start, end) => {
    vi.useFakeTimers({ now: new Date(2026, 9, 19, 15, 30), toFake: ['Date'] });
    const { setFilter } = renderWithRange();

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole('button', { name: label }));

    expect(setFilter).toHaveBeenCalledTimes(2);
    expect(setFilter).toHaveBeenNthCalledWith(1, 'from', start);
    expect(setFilter).toHaveBeenNthCalledWith(2, 'to', end);
  });

  it('marks the preset matching the current from/to as pressed', () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 19, 9, 0), toFake: ['Date'] });
    renderWithRange({ phone: '', from: '2026-10-13', to: '2026-10-19' });

    expect(screen.getByRole('button', { name: 'Last 7 Days' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-pressed', 'false');
  });
});
