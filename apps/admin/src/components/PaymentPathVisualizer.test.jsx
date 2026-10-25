import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import PaymentPathVisualizer, { extractPaymentPath, normalizeAsset, shortenId } from './PaymentPathVisualizer';

const POOL = 'a468d41d8e9b8f3c7209651608b74b7db7bac944b4bd9c5b3a5ac0eb4d0d2fe1';
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

const direct = {
  pathPayment: { sourceAsset: `USDC:${ISSUER}`, sourceAmount: '10', destAsset: 'NGN', destAmount: '15500' },
};
const multiHop = {
  metadata: {
    pathPayment: {
      sourceAsset: 'USDC', sourceAmount: 10, destAsset: 'NGN', destAmount: 15500,
      path: ['native'],
      hops: [
        { type: 'orderbook', amountIn: 10, amountOut: 80 },
        { type: 'amm', poolId: POOL, rate: 193.75 },
      ],
    },
  },
};

describe('normalizeAsset', () => {
  it.each([
    [`USDC:${ISSUER}`, { code: 'USDC', issuer: ISSUER }],
    ['native', { code: 'XLM', issuer: null }],
    [{ asset_type: 'native' }, { code: 'XLM', issuer: null }],
    [{ asset_code: 'NGN', asset_issuer: 'GX' }, { code: 'NGN', issuer: 'GX' }],
  ])('parses %j', (input, expected) => expect(normalizeAsset(input)).toEqual(expected));

  it.each([[undefined], [null], [''], [{}]])('rejects %j', (input) => expect(normalizeAsset(input)).toBeNull());
});

describe('extractPaymentPath', () => {
  it('returns null without path data or for same-asset payments', () => {
    expect(extractPaymentPath({})).toBeNull();
    expect(extractPaymentPath({ metadata: {} })).toBeNull();
    expect(extractPaymentPath({ pathPayment: { sourceAsset: 'XLM', destAsset: 'native' } })).toBeNull();
    expect(extractPaymentPath({ pathPayment: { sourceAsset: 'USDC' } })).toBeNull();
  });

  it('derives the exchange rate from amounts for a direct conversion', () => {
    const path = extractPaymentPath(direct);
    expect(path.nodes.map((n) => n.code)).toEqual(['USDC', 'NGN']);
    expect(path.segments).toHaveLength(1);
    expect(path.segments[0]).toMatchObject({ venue: 'orderbook', rate: 1550 });
    expect(path.overallRate).toBe(1550);
  });

  it('builds multi-hop segments with venue, rate and pool id', () => {
    const path = extractPaymentPath(multiHop);
    expect(path.nodes.map((n) => n.code)).toEqual(['USDC', 'XLM', 'NGN']);
    expect(path.segments[0]).toMatchObject({ venue: 'orderbook', rate: 8, poolId: null });
    expect(path.segments[1]).toMatchObject({ venue: 'amm', rate: 193.75, poolId: POOL });
  });
});

describe('shortenId', () => {
  it('keeps short ids and truncates long ones', () => {
    expect(shortenId('abc')).toBe('abc');
    expect(shortenId(POOL)).toBe(`${POOL.slice(0, 6)}…${POOL.slice(-6)}`);
    expect(shortenId(undefined)).toBe('');
  });
});

describe('PaymentPathVisualizer', () => {
  it('renders nothing when the transaction has no path', () => {
    const { container } = render(<PaymentPathVisualizer tx={{ amount: 5 }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('labels source, destination, venue, rates and pool id', () => {
    render(<PaymentPathVisualizer tx={multiHop} />);
    expect(screen.getByRole('heading', { name: 'Payment Path' })).toBeInTheDocument();
    expect(screen.getByLabelText('Source asset USDC')).toBeInTheDocument();
    expect(screen.getByLabelText('Intermediate asset XLM')).toBeInTheDocument();
    expect(screen.getByLabelText('Destination asset NGN')).toBeInTheDocument();
    expect(screen.getByTestId('path-overall-rate')).toHaveTextContent('1 USDC ≈ 1,550 NGN');
    const segments = screen.getAllByTestId('path-segment');
    expect(segments).toHaveLength(2);
    expect(within(segments[0]).getByText('Orderbook')).toBeInTheDocument();
    expect(within(segments[0]).getByTestId('segment-rate')).toHaveTextContent('1 USDC = 8 XLM');
    expect(within(segments[1]).getByText('AMM Pool')).toBeInTheDocument();
    expect(within(segments[1]).getByTestId('segment-pool-id')).toHaveAttribute('title', POOL);
    expect(within(segments[1]).getByTestId('segment-pool-id')).toHaveTextContent('Pool ID: a468d4…');
  });

  it('shows asset details when a node is selected and toggles them off', () => {
    render(<PaymentPathVisualizer tx={direct} />);
    const node = screen.getByLabelText('Source asset USDC');
    expect(screen.queryByTestId('path-node-details')).not.toBeInTheDocument();
    fireEvent.click(node);
    expect(node).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('path-node-details')).toHaveTextContent(ISSUER);
    fireEvent.click(node);
    expect(screen.queryByTestId('path-node-details')).not.toBeInTheDocument();
  });

  it('lists the full pool id in the details of a selected node', () => {
    render(<PaymentPathVisualizer tx={multiHop} />);
    fireEvent.click(screen.getByLabelText('Intermediate asset XLM'));
    const details = screen.getByTestId('path-node-details');
    expect(details).toHaveTextContent('Native asset');
    expect(details).toHaveTextContent(POOL);
  });
});
