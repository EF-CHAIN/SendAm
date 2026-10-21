import { describe, it, expect, vi } from 'vitest';
import { generateReceiptHtml, exportReceiptPdf } from './receiptPdf';

describe('receiptPdf generator', () => {
  const mockTx = {
    _id: 'tx_123456789',
    txHash: 'stellar_hash_abcdef',
    amount: '150.00',
    asset: 'USDC',
    fiatAmount: '150.00',
    fiatCurrency: 'USD',
    status: 'success',
    type: 'transfer',
    rail: 'stellar',
    userId: { phoneNumber: '+2348011112222' },
    recipientPhoneNumber: '+2348099998888',
    createdAt: '2026-09-27T04:00:00.000Z',
    explorerUrl: 'https://stellar.expert/explorer/public/tx/stellar_hash_abcdef',
  };

  it('generates well-formatted HTML with transaction attributes', () => {
    const html = generateReceiptHtml(mockTx);
    expect(html).toContain('SendAm Transaction Receipt');
    expect(html).toContain('tx_123456789');
    expect(html).toContain('150.00 USDC');
    expect(html).toContain('+2348011112222');
    expect(html).toContain('+2348099998888');
    expect(html).toContain('stellar_hash_abcdef');
    expect(html).toContain('SUCCESS');
    expect(html).toContain('Verification QR Code');
  });

  it('handles missing/null optional fields gracefully', () => {
    const minTx = {
      id: 'tx_minimal',
      status: 'pending',
    };
    const html = generateReceiptHtml(minTx);
    expect(html).toContain('tx_minimal');
    expect(html).toContain('PENDING');
  });

  it('exports receipt PDF via new window print dialog', () => {
    const mockDocument = {
      open: vi.fn(),
      write: vi.fn(),
      close: vi.fn(),
    };
    const mockWindow = {
      document: mockDocument,
      focus: vi.fn(),
    };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(mockWindow);

    exportReceiptPdf(mockTx);
    expect(openSpy).toHaveBeenCalledWith('', '_blank', expect.stringContaining('width='));
    expect(mockDocument.write).toHaveBeenCalledWith(expect.stringContaining('tx_123456789'));
    expect(mockDocument.close).toHaveBeenCalled();
    expect(mockWindow.focus).toHaveBeenCalled();
  });
});
