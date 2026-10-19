import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
    expect(screen.getByText(new RegExp(expectedNgn))).toBeInTheDocument();
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
    expect(screen.getByText(new RegExp(expectedNgn))).toBeInTheDocument();
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
    expect(screen.getByText(new RegExp(expectedKes))).toBeInTheDocument();
    expect(screen.getByText(/1 USD = 129 KES/i)).toBeInTheDocument();
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
    expect(screen.getByText(new RegExp(expectedNgn))).toBeInTheDocument();
    expect(screen.getByText(/1 GBP = 1,980 NGN/i)).toBeInTheDocument();
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
