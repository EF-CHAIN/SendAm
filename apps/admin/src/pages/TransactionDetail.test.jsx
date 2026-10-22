import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import TransactionDetail from './TransactionDetail';
import { describe, it, expect, vi } from 'vitest';
import * as adminApi from '@/lib/adminApi';

vi.mock('@/lib/receiptPdf', () => ({
  exportReceiptPdf: vi.fn(),
}));

describe('TransactionDetail Component - Explorer Deep Links', () => {
  it('renders dynamic Stellar.Expert and Horizon deep-links for testnet transaction', async () => {
    vi.spyOn(adminApi, 'getAdminTransaction').mockResolvedValueOnce({
      data: {
        _id: 'tx_testnet_1',
        txHash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        network: 'testnet',
        status: 'completed',
        amount: '50.00',
        asset: 'USDC',
        type: 'transfer',
        createdAt: '2026-10-20T10:00:00Z',
      },
    });

    render(
      <MemoryRouter initialEntries={['/transactions/tx_testnet_1']}>
        <Routes>
          <Route path="/transactions/:id" element={<TransactionDetail />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Transaction Detail')).toBeInTheDocument();
    });

    // Check Stellar.Expert deep-link buttons/links
    const stellarExpertLinks = screen.getAllByRole('link', { name: /view on stellar\.expert/i });
    expect(stellarExpertLinks.length).toBeGreaterThan(0);
    for (const link of stellarExpertLinks) {
      expect(link).toHaveAttribute(
        'href',
        'https://stellar.expert/explorer/testnet/tx/abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'
      );
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }

    // Check Horizon JSON deep-link buttons/links
    const horizonLinks = screen.getAllByRole('link', { name: /view horizon json/i });
    expect(horizonLinks.length).toBeGreaterThan(0);
    for (const link of horizonLinks) {
      expect(link).toHaveAttribute(
        'href',
        'https://horizon-testnet.stellar.org/transactions/abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'
      );
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  it('renders public network deep-links when network is public', async () => {
    vi.spyOn(adminApi, 'getAdminTransaction').mockResolvedValueOnce({
      data: {
        _id: 'tx_pub_1',
        txHash: '9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba',
        network: 'public',
        status: 'completed',
        amount: '100.00',
        asset: 'XLM',
        type: 'transfer',
        createdAt: '2026-10-20T10:00:00Z',
      },
    });

    render(
      <MemoryRouter initialEntries={['/transactions/tx_pub_1']}>
        <Routes>
          <Route path="/transactions/:id" element={<TransactionDetail />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Transaction Detail')).toBeInTheDocument();
    });

    const stellarExpertLinks = screen.getAllByRole('link', { name: /view on stellar\.expert/i });
    expect(stellarExpertLinks[0]).toHaveAttribute(
      'href',
      'https://stellar.expert/explorer/public/tx/9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba'
    );

    const horizonLinks = screen.getAllByRole('link', { name: /view horizon json/i });
    expect(horizonLinks[0]).toHaveAttribute(
      'href',
      'https://horizon.stellar.org/transactions/9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba'
    );
  });
});
