import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import CurrencyCalculator from './CurrencyCalculator.jsx';
import { EXCHANGE_RATES } from '@/lib/currencyConstants.js';

describe('CurrencyCalculator Component', () => {
  it('renders with default values (100 USD to NGN)', () => {
    render(<CurrencyCalculator />);

    expect(screen.getByRole('heading', { name: /see how much your recipient gets/i })).toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: /send amount in usd/i });
    expect(input).toHaveValue('100');

    // 100 - 1% (1 USD) = 99 USD * 1550 = 153,450 NGN
    const expectedNgn = (99 * EXCHANGE_RATES.USD.NGN).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    expect(screen.getAllByText(new RegExp(expectedNgn)).length).toBeGreaterThan(0);
    expect(screen.getByText('$1.00')).toBeInTheDocument(); // 1% fee
    expect(screen.getByText('$7.00')).toBeInTheDocument(); // 7% traditional fee
  });

  it('updates calculations when user types a new amount', () => {
    render(<CurrencyCalculator />);
    const input = screen.getByRole('textbox', { name: /send amount in usd/i });

    fireEvent.change(input, { target: { value: '500' } });
    expect(input).toHaveValue('500');

    // 500 - 1% (5 USD) = 495 USD * 1550 = 767,250 NGN
    const expectedNgn = (495 * EXCHANGE_RATES.USD.NGN).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    expect(screen.getAllByText(new RegExp(expectedNgn)).length).toBeGreaterThan(0);
    expect(screen.getByText('$5.00')).toBeInTheDocument();
  });

  it('updates amount when a quick preset button is clicked', () => {
    render(<CurrencyCalculator />);

    const preset250 = screen.getByRole('button', { name: '$250' });
    fireEvent.click(preset250);

    const input = screen.getByRole('textbox', { name: /send amount in usd/i });
    expect(input).toHaveValue('250');
  });

  it('updates rate and converted amount when changing target currency', () => {
    render(<CurrencyCalculator />);

    // Change corridor tab to Kenya (KES)
    const kenyaTab = screen.getByRole('button', { name: /send to kenya/i });
    fireEvent.click(kenyaTab);

    // 100 - 1 = 99 USD * 129 = 12,771 KES
    const expectedKes = (99 * EXCHANGE_RATES.USD.KES).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    expect(screen.getAllByText(new RegExp(expectedKes)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1 USD = 129 KES/i).length).toBeGreaterThan(0);
  });

  it('updates rate when changing source currency to EUR or GBP', () => {
    render(<CurrencyCalculator />);

    const sourceSelect = screen.getByRole('combobox', { name: /source currency/i });
    fireEvent.change(sourceSelect, { target: { value: 'GBP' } });

    // 100 - 1 = 99 GBP * 1980 = 196,020 NGN
    const expectedNgn = (99 * EXCHANGE_RATES.GBP.NGN).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    expect(screen.getAllByText(new RegExp(expectedNgn)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1 GBP = 1,980 NGN/i).length).toBeGreaterThan(0);
  });

  it('toggles the fee breakdown drawer with correct ARIA wiring', () => {
    render(<CurrencyCalculator />);

    const toggle = screen.getByRole('button', { name: /view fee breakdown/i });

    // Collapsed: hidden from the accessibility tree entirely.
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: /fee breakdown/i })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const region = screen.getByRole('region', { name: /fee breakdown/i });
    expect(toggle).toHaveAttribute('aria-controls', region.id);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('itemizes fees that sum exactly to the net send amount', () => {
    render(<CurrencyCalculator />);

    fireEvent.click(screen.getByRole('button', { name: /view fee breakdown/i }));

    // 100.00 sent − 1.00 service fee = 99.00 net; the network fee is covered
    // by SendAm, so it never changes the sum.
    expect(screen.getByText('You send').nextSibling).toHaveTextContent('$100.00');
    expect(screen.getByText(/sendam service fee \(1%\)/i).nextSibling).toHaveTextContent('−$1.00');
    expect(screen.getByText(/stellar network fee/i).nextSibling).toHaveTextContent('<$0.0001');
    expect(screen.getByText('Net send amount').nextSibling).toHaveTextContent('$99.00');
    expect(screen.getByText('Guaranteed FX rate').nextSibling).toHaveTextContent(
      `1 USD = ${EXCHANGE_RATES.USD.NGN.toLocaleString()} NGN`
    );

    const expectedNgn = (99 * EXCHANGE_RATES.USD.NGN).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    expect(screen.getByText('Recipient gets').nextSibling).toHaveTextContent(`₦${expectedNgn}`);
  });

  it('keeps the breakdown itemization in sync with a changed amount', () => {
    render(<CurrencyCalculator />);

    fireEvent.click(screen.getByRole('button', { name: /view fee breakdown/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /send amount in usd/i }), {
      target: { value: '250' },
    });

    expect(screen.getByText('You send').nextSibling).toHaveTextContent('$250.00');
    expect(screen.getByText(/sendam service fee \(1%\)/i).nextSibling).toHaveTextContent('−$2.50');
    expect(screen.getByText('Net send amount').nextSibling).toHaveTextContent('$247.50');
  });

  it('swaps currencies and carries the received amount over on swap', () => {
    render(<CurrencyCalculator />);

    const swapButton = screen.getByRole('button', { name: /swap currencies/i });
    fireEvent.click(swapButton);

    // Corridor reverses from USD -> NGN to NGN -> USD.
    expect(screen.getByRole('combobox', { name: /source currency/i })).toHaveValue('NGN');
    expect(screen.getByRole('combobox', { name: /recipient gets/i })).toHaveValue('USD');

    // 100 - 1% = 99 USD * 1550 = 153,450 NGN becomes the new send amount.
    const input = screen.getByRole('textbox', { name: /send amount in ngn/i });
    expect(input).toHaveValue('153450');

    // 153,450 - 1% = 151,915.5 NGN at 1/1550 = 98.01 USD
    expect(screen.getByText(/1 NGN = 0\.000645 USD/i)).toBeInTheDocument();
    expect(screen.getByText(/98\.01/)).toBeInTheDocument();
  });

  it('round-trips the corridor back to the original direction', () => {
    render(<CurrencyCalculator />);

    const swapButton = screen.getByRole('button', { name: /swap currencies/i });
    fireEvent.click(swapButton);
    fireEvent.click(swapButton);

    expect(screen.getByRole('combobox', { name: /source currency/i })).toHaveValue('USD');
    expect(screen.getByRole('combobox', { name: /recipient gets/i })).toHaveValue('NGN');

    // 153,450 NGN -> 98.01 USD on the way, and back to a USD send amount.
    const input = screen.getByRole('textbox', { name: /send amount in usd/i });
    expect(input).toHaveValue('98.01');
  });

  it('rotates the swap button in 300ms steps and exposes the transition', () => {
    render(<CurrencyCalculator />);

    const swapButton = screen.getByRole('button', { name: /swap currencies/i });
    expect(swapButton.getAttribute('style')).toContain('rotate(0deg)');

    fireEvent.click(swapButton);
    expect(swapButton.getAttribute('style')).toContain('rotate(180deg)');

    fireEvent.click(swapButton);
    expect(swapButton.getAttribute('style')).toContain('rotate(360deg)');

    expect(swapButton.getAttribute('class')).toContain('duration-300');
  });
});

describe('CurrencyCalculator rate freshness (#716)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts down from 30s and refreshes when it reaches zero', async () => {
    vi.useFakeTimers();
    const refreshRates = vi.fn().mockResolvedValue({});
    render(<CurrencyCalculator refreshRates={refreshRates} />);

    expect(screen.getByText('Rates refresh in 30s')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(screen.getByText('Rates refresh in 27s')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(28_000);
    });
    expect(refreshRates).toHaveBeenCalledTimes(1);
    // The refresh resolved at t=30s, so the tick at t=31s shows a restarted
    // countdown one second in.
    expect(screen.getByText('Rates refresh in 29s')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('warns when the refresh fails, with a red dot instead of the pulse', async () => {
    vi.useFakeTimers();
    const refreshRates = vi.fn().mockRejectedValue(new Error('offline (simulated)'));
    const { container } = render(<CurrencyCalculator refreshRates={refreshRates} />);

    // Past the 30s refresh point (refresh fails), then past the 60s stale mark.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });

    const warning = screen.getByRole('alert');
    expect(warning).toHaveTextContent(/could not be refreshed/i);
    expect(container.querySelector('[data-testid="rate-freshness"] .bg-red-500')).not.toBeNull();
    expect(container.querySelector('[data-testid="rate-freshness"] .animate-pulse')).toBeNull();
  });

  it('warns about age alone while a refresh hangs, without claiming a failure', async () => {
    vi.useFakeTimers();
    const refreshRates = vi.fn(() => new Promise(() => {})); // never settles
    render(<CurrencyCalculator refreshRates={refreshRates} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });

    const warning = screen.getByRole('alert');
    expect(warning).toHaveTextContent(/more than a minute old/i);
    expect(warning).not.toHaveTextContent(/could not be refreshed/i);
  });
});

describe('CurrencyCalculator boundaries', () => {
  const amountInput = () => screen.getByRole('textbox', { name: /send amount in usd/i });

  it('shows zero values for a zero amount', () => {
    render(<CurrencyCalculator />);
    fireEvent.change(amountInput(), { target: { value: '0' } });
    expect(screen.getByText(/₦ 0\.00/)).toBeInTheDocument();
    expect(screen.getAllByText('$0.00')).toHaveLength(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('treats an empty amount as zero', () => {
    render(<CurrencyCalculator />);
    fireEvent.change(amountInput(), { target: { value: '' } });
    expect(amountInput()).toHaveValue('');
    expect(screen.getByText(/₦ 0\.00/)).toBeInTheDocument();
  });

  it('ignores negative and malformed keystrokes', () => {
    render(<CurrencyCalculator />);
    for (const value of ['-5', '1e3', 'abc', '10.123']) {
      fireEvent.change(amountInput(), { target: { value } });
      expect(amountInput()).toHaveValue('100');
    }
  });

  it('quotes two-decimal amounts exactly', () => {
    render(<CurrencyCalculator />);
    fireEvent.change(amountInput(), { target: { value: '0.10' } });
    // 0.10 - 1% = 0.099 * 1550 = 153.45 NGN
    expect(screen.getByText(/₦ 153\.45/)).toBeInTheDocument();
  });

  it('accepts the maximum transfer amount without a warning', () => {
    render(<CurrencyCalculator />);
    fireEvent.change(amountInput(), { target: { value: '1000' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('$10.00')).toBeInTheDocument();
  });

  it('caps amounts above the maximum and announces the limit', () => {
    render(<CurrencyCalculator />);
    fireEvent.change(amountInput(), { target: { value: '99999999999.99' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/maximum per transfer is \$1,000/i);
    // The quote uses the 1,000 maximum: 990 * 1550 = 1,534,500 NGN.
    const expected = (990 * EXCHANGE_RATES.USD.NGN).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    expect(screen.getByText(new RegExp(expected))).toBeInTheDocument();
  });

  it('requotes when the recipient currency select changes', () => {
    render(<CurrencyCalculator />);
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[1], { target: { value: 'GHS' } });
    // 99 USD * 15.5 = 1,534.50 GHS
    expect(screen.getByText(/GH₵ 1,534\.50/)).toBeInTheDocument();
    expect(screen.getByText(/1 USD = 15\.5 GHS/)).toBeInTheDocument();
  });
});
