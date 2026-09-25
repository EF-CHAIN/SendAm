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
});
