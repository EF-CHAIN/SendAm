import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EXCHANGE_RATES } from '@/lib/currencyConstants.js';

// Control useDeferredValue so we can observe the "input is ahead of the quote"
// window that real React only exposes while it is busy.
const deferral = vi.hoisted(() => ({ frozen: false, held: new Map() }));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useDeferredValue: (value) => {
      // One slot per call site, in call order, is enough for this component.
      const ref = actual.useRef(value);
      if (!deferral.frozen) ref.current = value;
      return ref.current;
    },
  };
});

import CurrencyCalculator from './CurrencyCalculator.jsx';

const fmt = (n) =>
  n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

describe('CurrencyCalculator input prioritisation', () => {
  beforeEach(() => {
    deferral.frozen = false;
  });

  it('keeps the input responsive while the quote lags behind', () => {
    render(<CurrencyCalculator />);
    const input = screen.getByRole('textbox', { name: /send amount in usd/i });
    const results = screen.getByText('Recipient Gets (Est.)').closest('[data-stale]');
    expect(results).toHaveAttribute('data-stale', 'false');

    deferral.frozen = true;
    fireEvent.change(input, { target: { value: '500' } });

    // Urgent update: the field already shows the new value ...
    expect(input).toHaveValue('500');
    // ... while the expensive output still shows the previous quote and is flagged busy.
    expect(screen.getByText(new RegExp(fmt(99 * EXCHANGE_RATES.USD.NGN)))).toBeInTheDocument();
    expect(results).toHaveAttribute('data-stale', 'true');
    expect(results).toHaveAttribute('aria-busy', 'true');
  });

  it('catches up and clears the busy flag once the deferred value settles', () => {
    render(<CurrencyCalculator />);
    const input = screen.getByRole('textbox', { name: /send amount in usd/i });
    const results = screen.getByText('Recipient Gets (Est.)').closest('[data-stale]');

    deferral.frozen = true;
    fireEvent.change(input, { target: { value: '500' } });
    expect(results).toHaveAttribute('aria-busy', 'true');

    deferral.frozen = false;
    fireEvent.change(input, { target: { value: '500' } }); // no-op value, forces re-render
    fireEvent.change(input, { target: { value: '501' } });
    expect(screen.getByText(new RegExp(fmt(495.99 * EXCHANGE_RATES.USD.NGN)))).toBeInTheDocument();
    expect(results).toHaveAttribute('aria-busy', 'false');
  });

  it('still rejects invalid keystrokes without touching the quote (failure mode)', () => {
    render(<CurrencyCalculator />);
    const input = screen.getByRole('textbox', { name: /send amount in usd/i });
    fireEvent.change(input, { target: { value: '12abc' } });
    expect(input).toHaveValue('100');
    fireEvent.change(input, { target: { value: '1.234' } });
    expect(input).toHaveValue('100');
  });

  it('treats a cleared field as a zero quote rather than NaN', () => {
    render(<CurrencyCalculator />);
    const input = screen.getByRole('textbox', { name: /send amount in usd/i });
    fireEvent.change(input, { target: { value: '' } });
    expect(input).toHaveValue('');
    expect(screen.getByText(new RegExp(`₦ ${fmt(0)}`))).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/NaN/);
  });

  it('applies corridor tab switches as a transition and settles on the new rate', () => {
    render(<CurrencyCalculator />);
    fireEvent.click(screen.getByRole('button', { name: /send to ghana/i }));
    expect(screen.getByText(new RegExp(fmt(99 * EXCHANGE_RATES.USD.GHS)))).toBeInTheDocument();
    expect(screen.getByText('Recipient Gets (Est.)').closest('[data-stale]')).toHaveAttribute('aria-busy', 'false');
  });

  it('applies a preset amount through the transition path', () => {
    render(<CurrencyCalculator />);
    fireEvent.click(screen.getByRole('button', { name: '$500' }));
    expect(screen.getByRole('textbox', { name: /send amount in usd/i })).toHaveValue('500');
    expect(screen.getByText('$5.00')).toBeInTheDocument();
  });
});
