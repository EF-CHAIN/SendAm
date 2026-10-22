import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import JsonTreeView from './JsonTreeView';

const sample = {
  fee: 100,
  memo: 'Payment reference',
  feeBump: false,
  signer: null,
  operations: [{ type: 'payment', amount: '75' }],
};

describe('JsonTreeView', () => {
  it('renders keys and primitives with their syntax colors', () => {
    render(<JsonTreeView data={sample} />);

    expect(screen.getByText('fee:')).toHaveClass('text-sky-400');
    expect(screen.getByText('100')).toHaveClass('text-orange-400');
    expect(screen.getByText('"Payment reference"')).toHaveClass('text-emerald-400');
    expect(screen.getByText('false')).toHaveClass('text-fuchsia-400');
    expect(screen.getByText('null')).toHaveClass('text-gray-400');
  });

  it('collapses and re-expands a branch with aria-expanded kept in sync', () => {
    render(<JsonTreeView data={sample} defaultExpandedDepth={3} />);

    const operations = screen.getByTestId('json-node-root.operations');
    expect(operations).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('"payment"')).toBeInTheDocument();

    fireEvent.click(operations);
    expect(operations).toHaveAttribute('aria-expanded', 'false');
    expect(operations).toHaveTextContent('[…] 1 item');
    expect(screen.queryByText('"payment"')).not.toBeInTheDocument();

    fireEvent.click(operations);
    expect(screen.getByText('"payment"')).toBeInTheDocument();
  });

  it('starts branches beyond the default depth collapsed', () => {
    render(<JsonTreeView data={{ outer: { inner: { deep: 1 } } }} defaultExpandedDepth={2} />);

    // root (0) and outer (1) expand; inner (2) starts collapsed.
    expect(screen.getByTestId('json-node-root.outer.inner')).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.queryByText('deep:')).not.toBeInTheDocument();
  });
});
