import { buildSep7PaymentUri, isValidSep7Uri, normalizeSep7Uri } from '../paymentRequest';

describe('SEP-0007 payment request URI validation', () => {
  it('accepts a payment URI with a destination', () => {
    const uri = 'web+stellar:pay?destination=GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO&amount=1.25';
    expect(isValidSep7Uri(uri)).toBe(true);
    expect(normalizeSep7Uri(`  ${uri}  `)).toBe(uri);
  });

  it('accepts a transaction URI with XDR', () => {
    expect(isValidSep7Uri('web+stellar:tx?xdr=AAAA')).toBe(true);
  });

  it('rejects missing required operation parameters', () => {
    expect(isValidSep7Uri('web+stellar:pay?amount=1')).toBe(false);
    expect(isValidSep7Uri('web+stellar:tx?network_passphrase=testnet')).toBe(false);
  });

  it('rejects unrelated schemes, empty input, and oversized values', () => {
    expect(isValidSep7Uri('https://example.com')).toBe(false);
    expect(isValidSep7Uri('')).toBe(false);
    expect(isValidSep7Uri(`web+stellar:pay?destination=GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO&msg=${'A'.repeat(3000)}`)).toBe(false);
  });
});

describe('SEP-0007 payment URI generation', () => {
  it('builds a native XLM payment URI from a valid destination and amount', () => {
    const uri = buildSep7PaymentUri({
      destination: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
      amount: 1.25,
      asset: 'XLM',
    });
    expect(uri).toBe('web+stellar:pay?destination=GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO&amount=1.25');
    expect(isValidSep7Uri(uri)).toBe(true);
  });

  it('does not guess an issuer for issued assets or accept invalid amounts', () => {
    expect(buildSep7PaymentUri({ destination: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO', amount: 2, asset: 'USDC' })).toBe('');
    expect(buildSep7PaymentUri({ destination: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO', amount: 0, asset: 'XLM' })).toBe('');
  });
});
