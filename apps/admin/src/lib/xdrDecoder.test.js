import { describe, it, expect } from 'vitest';
import * as StellarSdk from '@stellar/stellar-sdk';
import { decodeStellarXdr, stroopsToXlm, formatAsset } from './xdrDecoder';

describe('xdrDecoder utility', () => {
  const sourceKeyPair = StellarSdk.Keypair.random();
  const destKeyPair = StellarSdk.Keypair.random();
  const account = new StellarSdk.Account(sourceKeyPair.publicKey(), '100');

  it('correctly converts stroops to XLM', () => {
    expect(stroopsToXlm(10000000)).toBe('1');
    expect(stroopsToXlm(100)).toBe('0.00001');
    expect(stroopsToXlm(0)).toBe('0');
    expect(stroopsToXlm(null)).toBe('0');
  });

  it('correctly formats assets', () => {
    expect(formatAsset(StellarSdk.Asset.native())).toBe('Native (XLM)');
    const customAsset = new StellarSdk.Asset('USDC', sourceKeyPair.publicKey());
    expect(formatAsset(customAsset)).toContain('USDC');
  });

  it('decodes a valid Stellar TransactionEnvelope with Payment and ChangeTrust operations', () => {
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: StellarSdk.Networks.TESTNET,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: destKeyPair.publicKey(),
          asset: StellarSdk.Asset.native(),
          amount: '50',
        })
      )
      .addOperation(
        StellarSdk.Operation.changeTrust({
          asset: new StellarSdk.Asset('USDC', destKeyPair.publicKey()),
          limit: '1000',
        })
      )
      .addMemo(StellarSdk.Memo.text('Invoice #1234'))
      .setTimeout(30)
      .build();

    tx.sign(sourceKeyPair);
    const xdr = tx.toXDR();

    const result = decodeStellarXdr(xdr, StellarSdk.Networks.TESTNET);

    expect(result.success).toBe(true);
    expect(result.sourceAccount).toBe(sourceKeyPair.publicKey());
    expect(result.sequence).toBe('101');
    expect(result.fee.stroops).toBe('200');
    expect(result.memo.type).toBe('text');
    expect(result.memo.value).toBe('Invoice #1234');
    expect(result.operationCount).toBe(2);

    expect(result.operations[0].type).toBe('payment');
    expect(result.operations[0].summary).toContain('Payment: 50');
    expect(result.operations[1].type).toBe('changeTrust');
    expect(result.operations[1].summary).toContain('Change Trust: USDC');

    expect(result.signatures.length).toBe(1);
    expect(result.signatures[0].hint).toBeDefined();
  });

  it('decodes CreateAccount and ManageData operations', () => {
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: '200',
      networkPassphrase: StellarSdk.Networks.PUBLIC,
    })
      .addOperation(
        StellarSdk.Operation.createAccount({
          destination: destKeyPair.publicKey(),
          startingBalance: '25',
        })
      )
      .addOperation(
        StellarSdk.Operation.manageData({
          name: 'session_id',
          value: 'abc-xyz',
        })
      )
      .setTimeout(0)
      .build();

    tx.sign(sourceKeyPair);
    const xdr = tx.toXDR();

    const result = decodeStellarXdr(xdr, StellarSdk.Networks.PUBLIC);
    expect(result.success).toBe(true);
    expect(result.operations.length).toBe(2);
    expect(result.operations[0].type).toBe('createAccount');
    expect(result.operations[0].summary).toContain('Create Account');
    expect(result.operations[1].type).toBe('manageData');
    expect(result.operations[1].summary).toContain('Manage Data');
  });

  it('throws a descriptive error when decoding invalid or malformed XDR', () => {
    expect(() => decodeStellarXdr('')).toThrow('XDR string cannot be empty');
    expect(() => decodeStellarXdr('not-a-valid-base64-xdr-string-here!')).toThrow('Failed to decode Stellar XDR');
  });
});
