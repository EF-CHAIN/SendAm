import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import FilterBar from './FilterBar';

const fields = [
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
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
      fields={fields}
      fields={testFields}
      getFilter={(key) => values[key]}
      setFilter={setFilter}
      onReset={onReset}
    />
  );
  return { ...utils, setFilter, onReset };
};

describe('FilterBar', () => {
describe('FilterBar accessibility and interactions', () => {
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
    expect(controls).toHaveLength(fields.length + 1);
    controls.forEach((control) => {
      expect(control).toHaveAccessibleName();
    });
    fields.forEach((field) => {
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
    expect(setFilter).toHaveBeenCalledWith('phone', '1');

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
