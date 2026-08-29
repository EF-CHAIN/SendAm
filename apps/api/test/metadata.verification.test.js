const test = require('node:test');
const assert = require('node:assert/strict');
const { MetadataVerifier } = require('../src/wallet/metadataVerifier');

const VALID_STELLAR_ADDR = 'GA2C5W6B63OTMYIEPCHVRWTH37EAKHQYWRST2B6G4DTHB7LTYW5Q3J7J';
const VALID_ISSUER_ADDR  = 'GA5ZSEACVEHVAKVXDDFW2ZEW2W5E23BLTC2FFENDDEV6KZ23WSSW264E';

test('MetadataVerifier - validates valid Stellar XLM address', () => {
  const verifier = new MetadataVerifier();
  const result = verifier.validateMetadata({
    destinationAddress: VALID_STELLAR_ADDR,
    assetCode: 'XLM',
  });

  assert.equal(result.isValid, true);
  assert.equal(result.validatedMetadata.destinationAddress, VALID_STELLAR_ADDR);
});

test('MetadataVerifier - rejects invalid Stellar address format', () => {
  const verifier = new MetadataVerifier();
  const result = verifier.validateMetadata({
    destinationAddress: 'INVALID_ADDRESS_123',
    assetCode: 'XLM',
  });

  assert.equal(result.isValid, false);
  assert.ok(result.errors[0].includes('Invalid destination Stellar wallet address'));
});

test('MetadataVerifier - validates USDC asset with valid issuer', () => {
  const verifier = new MetadataVerifier();
  const result = verifier.validateMetadata({
    destinationAddress: VALID_STELLAR_ADDR,
    assetCode: 'USDC',
    assetIssuer: VALID_ISSUER_ADDR,
  });

  assert.equal(result.isValid, true);
  assert.equal(result.validatedMetadata.assetCode, 'USDC');
});

test('MetadataVerifier - verifies HMAC provenance signature for metadata', () => {
  const verifier = new MetadataVerifier({ trustedSecret: 'secret_key_123' });
  const payload = {
    destinationAddress: VALID_STELLAR_ADDR,
    assetCode: 'USDC',
    assetIssuer: VALID_ISSUER_ADDR,
  };
  const signature = verifier.generateSignature(payload);

  const resultValid = verifier.validateMetadata({
    ...payload,
    sourceSignature: signature,
    requireSignature: true,
  });
  assert.equal(resultValid.isValid, true);

  const resultInvalidSig = verifier.validateMetadata({
    ...payload,
    sourceSignature: 'invalid_sig_hex',
    requireSignature: true,
  });
  assert.equal(resultInvalidSig.isValid, false);
  assert.ok(resultInvalidSig.errors[0].includes('signature check failed'));
});
