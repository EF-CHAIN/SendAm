/**
 * Client-side transaction receipt PDF generator.
 * Provides branded, downloadable PDF transaction receipts for operators and customers.
 */

/**
 * Escape HTML special characters for safe inclusion in generated HTML.
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Generate a printable/downloadable HTML receipt layout.
 * @param {Object} tx - The transaction object
 * @returns {string} - Renderable HTML string
 */
export function generateReceiptHtml(tx) {
  if (!tx) return '';

  const id = tx._id || tx.id || 'N/A';
  const txHash = tx.txHash || 'N/A';
  const amount = tx.amount !== undefined ? `${tx.amount} ${tx.asset || 'XLM'}` : 'N/A';
  const fiat = tx.fiatAmount ? `${tx.fiatAmount} ${tx.fiatCurrency || 'USD'}` : null;
  const status = (tx.status || 'unknown').toUpperCase();
  const date = tx.createdAt ? new Date(tx.createdAt).toUTCString() : new Date().toUTCString();
  const senderPhone = typeof tx.userId === 'object' && tx.userId?.phoneNumber ? tx.userId.phoneNumber : (typeof tx.userId === 'string' ? tx.userId : 'N/A');
  const recipientPhone = tx.recipientPhoneNumber || tx.destination || 'N/A';
  const rail = (tx.rail || 'Stellar Network').toUpperCase();
  const type = (tx.type || 'Transfer').toUpperCase();
  const explorerUrl = tx.explorerUrl || (tx.txHash ? `https://stellar.expert/explorer/public/tx/${tx.txHash}` : '');
  const verificationUrl = explorerUrl || `https://sendam.app/verify/${id}`;
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(verificationUrl)}`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>SendAm Transaction Receipt - ${escapeHtml(id)}</title>
  <style>
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      @page { margin: 15mm; size: auto; }
      .no-print { display: none !important; }
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #1e293b;
      background: #f8fafc;
      margin: 0;
      padding: 24px;
      display: flex;
      justify-content: center;
    }
    .receipt-card {
      background: #ffffff;
      max-width: 600px;
      width: 100%;
      border-radius: 16px;
      border: 1px solid #e2e8f0;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
      padding: 32px;
      box-sizing: border-box;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2px solid #f1f5f9;
      padding-bottom: 20px;
      margin-bottom: 24px;
    }
    .logo-container {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .logo-text {
      font-size: 24px;
      font-weight: 800;
      color: #0d9488;
      letter-spacing: -0.5px;
    }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.5px;
    }
    .badge-success { background: #dcfce7; color: #15803d; }
    .badge-pending { background: #fef9c3; color: #a16207; }
    .badge-failed { background: #fee2e2; color: #b91c1c; }
    .badge-unknown { background: #f1f5f9; color: #475569; }
    .amount-box {
      background: #f8fafc;
      border-radius: 12px;
      padding: 20px;
      text-align: center;
      margin-bottom: 24px;
      border: 1px solid #e2e8f0;
    }
    .amount-label {
      font-size: 13px;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .amount-val {
      font-size: 32px;
      font-weight: 800;
      color: #0f172a;
    }
    .fiat-val {
      font-size: 14px;
      color: #64748b;
      margin-top: 4px;
      font-weight: 500;
    }
    .details-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 24px;
    }
    .details-table td {
      padding: 10px 0;
      border-bottom: 1px solid #f1f5f9;
      font-size: 14px;
    }
    .details-table td.label {
      color: #64748b;
      font-weight: 500;
      width: 35%;
    }
    .details-table td.value {
      color: #0f172a;
      font-weight: 600;
      text-align: right;
      word-break: break-all;
    }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
    }
    .qr-section {
      display: flex;
      align-items: center;
      gap: 16px;
      background: #f8fafc;
      border: 1px dashed #cbd5e1;
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 24px;
    }
    .qr-img {
      width: 80px;
      height: 80px;
      border-radius: 8px;
      background: #ffffff;
      padding: 4px;
      border: 1px solid #e2e8f0;
    }
    .qr-info {
      flex: 1;
      font-size: 12px;
      color: #64748b;
    }
    .qr-info-title {
      font-size: 13px;
      font-weight: 700;
      color: #1e293b;
      margin-bottom: 4px;
    }
    .footer {
      text-align: center;
      font-size: 12px;
      color: #94a3b8;
      border-top: 1px solid #f1f5f9;
      padding-top: 16px;
    }
    .btn-print {
      display: block;
      width: 100%;
      background: #0d9488;
      color: #ffffff;
      border: none;
      padding: 12px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      margin-bottom: 16px;
      transition: background 0.2s;
    }
    .btn-print:hover {
      background: #0f766e;
    }
  </style>
</head>
<body>
  <div class="receipt-card">
    <div class="no-print">
      <button class="btn-print" onclick="window.print()">Print / Save as PDF</button>
    </div>
    <div class="header">
      <div class="logo-container">
        <span class="logo-text">SendAm</span>
      </div>
      <div>
        <span class="badge ${
          status === 'SUCCESS' ? 'badge-success' : status === 'PENDING' ? 'badge-pending' : status === 'FAILED' ? 'badge-failed' : 'badge-unknown'
        }">${escapeHtml(status)}</span>
      </div>
    </div>

    <div class="amount-box">
      <div class="amount-label">Transaction Amount</div>
      <div class="amount-val">${escapeHtml(amount)}</div>
      ${fiat ? `<div class="fiat-val">≈ ${escapeHtml(fiat)}</div>` : ''}
    </div>

    <table class="details-table">
      <tr>
        <td class="label">Receipt ID</td>
        <td class="value mono">${escapeHtml(id)}</td>
      </tr>
      <tr>
        <td class="label">Date & Time</td>
        <td class="value">${escapeHtml(date)}</td>
      </tr>
      <tr>
        <td class="label">Transaction Type</td>
        <td class="value">${escapeHtml(type)}</td>
      </tr>
      <tr>
        <td class="label">Payment Rail</td>
        <td class="value">${escapeHtml(rail)}</td>
      </tr>
      <tr>
        <td class="label">Sender</td>
        <td class="value">${escapeHtml(senderPhone)}</td>
      </tr>
      <tr>
        <td class="label">Recipient</td>
        <td class="value">${escapeHtml(recipientPhone)}</td>
      </tr>
      ${txHash !== 'N/A' ? `
      <tr>
        <td class="label">Stellar Tx Hash</td>
        <td class="value mono">${escapeHtml(txHash)}</td>
      </tr>` : ''}
    </table>

    <div class="qr-section">
      <img src="${escapeHtml(qrCodeUrl)}" alt="Verification QR Code" class="qr-img" />
      <div class="qr-info">
        <div class="qr-info-title">On-Chain Verification</div>
        <div>Scan this QR code or visit the blockchain explorer to verify the authenticity and finality of this transaction on the Stellar network.</div>
      </div>
    </div>

    <div class="footer">
      SendAm Payment Infrastructure • WhatsApp & Stellar Settled • Automated Operator Receipt
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Triggers a browser print dialog or open window with the styled receipt.
 * @param {Object} tx - The transaction object
 */
export function exportReceiptPdf(tx) {
  if (!tx) return;
  const receiptHtml = generateReceiptHtml(tx);
  const printWindow = window.open('', '_blank', 'width=800,height=900');
  if (printWindow) {
    printWindow.document.open();
    printWindow.document.write(receiptHtml);
    printWindow.document.close();
    printWindow.focus();
  }
}
