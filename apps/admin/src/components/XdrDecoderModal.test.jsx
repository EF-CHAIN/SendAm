import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import * as StellarSdk from '@stellar/stellar-sdk';
import XdrDecoderModal from './XdrDecoderModal';

describe('XdrDecoderModal Component', () => {
  const sourceKeyPair = StellarSdk.Keypair.random();
  const destKeyPair = StellarSdk.Keypair.random();
  const account = new StellarSdk.Account(sourceKeyPair.publicKey(), '100');

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: StellarSdk.Networks.PUBLIC,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: destKeyPair.publicKey(),
        asset: StellarSdk.Asset.native(),
        amount: '75',
      })
    )
    .addMemo(StellarSdk.Memo.text('Payment reference'))
    .setTimeout(0)
    .build();

  tx.sign(sourceKeyPair);
  const validXdr = tx.toXDR();

  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <XdrDecoderModal isOpen={false} onClose={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders modal header and decodes initial valid XDR envelope', () => {
    render(
      <XdrDecoderModal
        isOpen={true}
        onClose={vi.fn()}
        initialXdr={validXdr}
        txHash="0x1234567890abcdef"
      />
    );

    expect(screen.getByText('Stellar XDR Transaction Decoder')).toBeInTheDocument();
    expect(screen.getByText('TransactionEnvelope')).toBeInTheDocument();
    expect(screen.getByText(/Payment reference/i)).toBeInTheDocument();
    expect(screen.getByText(/Payment: 75/i)).toBeInTheDocument();
  });

  it('displays error state when an invalid XDR string is provided', () => {
    render(
      <XdrDecoderModal
        isOpen={true}
        onClose={vi.fn()}
        initialXdr="INVALID_BASE64_XDR"
      />
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Decoding Error:/i)).toBeInTheDocument();
  });

  it('switches between Operations, Signatures, and Raw JSON tabs', () => {
    render(
      <XdrDecoderModal
        isOpen={true}
        onClose={vi.fn()}
        initialXdr={validXdr}
      />
    );

    // Switch to Signatures tab
    const signaturesTab = screen.getByRole('button', { name: /Signatures/i });
    fireEvent.click(signaturesTab);
    expect(screen.getByText(/Signature #1/i)).toBeInTheDocument();

    // Switch to Raw JSON tab
    const rawJsonTab = screen.getByRole('button', { name: /Raw JSON/i });
    fireEvent.click(rawJsonTab);
    expect(screen.getByRole('button', { name: /Copy Formatted JSON/i })).toBeInTheDocument();
  });

  it('filters operations when typing into the search query input', () => {
    const multiOpTx = new StellarSdk.TransactionBuilder(account, {
      fee: '200',
      networkPassphrase: StellarSdk.Networks.PUBLIC,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: destKeyPair.publicKey(),
          asset: StellarSdk.Asset.native(),
          amount: '10',
        })
      )
      .addOperation(
        StellarSdk.Operation.changeTrust({
          asset: new StellarSdk.Asset('USDC', destKeyPair.publicKey()),
          limit: '500',
        })
      )
      .setTimeout(0)
      .build();

    multiOpTx.sign(sourceKeyPair);
    const multiXdr = multiOpTx.toXDR();

    render(
      <XdrDecoderModal
        isOpen={true}
        onClose={vi.fn()}
        initialXdr={multiXdr}
      />
    );

    const searchInput = screen.getByPlaceholderText(/Search operations by type/i);
    fireEvent.change(searchInput, { target: { value: 'USDC' } });

    expect(screen.getByText(/Change Trust: USDC/i)).toBeInTheDocument();
    expect(screen.queryByText(/Payment: 10 Native/i)).not.toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const handleClose = vi.fn();
    render(
      <XdrDecoderModal
        isOpen={true}
        onClose={handleClose}
        initialXdr=""
      />
    );

    const closeBtn = screen.getByRole('button', { name: 'Close modal' });
    fireEvent.click(closeBtn);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('displays a simulation error alert box translating Stellar result codes into clear operator instructions', () => {
    render(
      <XdrDecoderModal
        isOpen={true}
        onClose={vi.fn()}
        initialXdr='{"status": 400, "extras": {"result_codes": {"transaction": "tx_failed", "operations": ["op_underfunded"]}}}'
      />
    );

    expect(screen.getByTestId('simulation-error-alert')).toBeInTheDocument();
    expect(screen.getByText('Stellar Transaction Simulation Failed')).toBeInTheDocument();
    expect(screen.getByText('Insufficient Account Balance')).toBeInTheDocument();
    expect(screen.getByText('op_underfunded')).toBeInTheDocument();
    expect(screen.getByText(/Source wallet does not have enough XLM reserve/i)).toBeInTheDocument();
    expect(screen.getByText(/Top up the source account with additional XLM/i)).toBeInTheDocument();
  });

  it('translates op_no_trust error code into missing trustline remediation steps', () => {
    render(
      <XdrDecoderModal
        isOpen={true}
        onClose={vi.fn()}
        initialXdr="op_no_trust"
      />
    );

    const alert = screen.getByTestId('simulation-error-alert');
    expect(alert).toBeInTheDocument();
    expect(within(alert).getByText('Missing Trustline')).toBeInTheDocument();
    expect(within(alert).getByText('op_no_trust')).toBeInTheDocument();
    expect(within(alert).getByText(/The destination account does not have a trustline established/i)).toBeInTheDocument();
    expect(within(alert).getByText(/changeTrust operation/i)).toBeInTheDocument();
  });
});

describe('XdrDecoderModal raw JSON tree (#754)', () => {
  const keyPair = StellarSdk.Keypair.random();
  const account = new StellarSdk.Account(keyPair.publicKey(), '7');
  const treeTx = new StellarSdk.TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: StellarSdk.Networks.PUBLIC,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: StellarSdk.Keypair.random().publicKey(),
        asset: StellarSdk.Asset.native(),
        amount: '12',
      })
    )
    .setTimeout(0)
    .build();

  it('renders the raw tab as a collapsible tree with a Copy Formatted JSON action', () => {
    render(<XdrDecoderModal isOpen onClose={vi.fn()} initialXdr={treeTx.toXDR()} />);

    fireEvent.click(screen.getByRole('button', { name: /raw json/i }));

    expect(screen.getByTestId('json-tree')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy Formatted JSON/i })).toBeInTheDocument();

    // The root node is expandable and collapsing it hides the branch summary-free view.
    const root = screen.getByTestId('json-node-root');
    expect(root).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(root);
    expect(root).toHaveAttribute('aria-expanded', 'false');
  });
});
