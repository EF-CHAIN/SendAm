'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  PasskeyAdapter,
  PasskeyError,
  ChallengeExpiredError,
  InvalidSignatureError,
  UserVerificationRequiredError,
  normalizeSecp256r1PublicKey,
  toBase64Url,
} = require('../src/wallet/passkeyAdapter');

// Helper to simulate a real WebAuthn authenticator producing an assertion
function createMockWebAuthnAssertion({
  keypair,
  challenge,
  origin = 'https://sendam.me',
  rpId = 'sendam.me',
  userVerified = true,
  userPresent = true,
  signCount = 1,
  tamperSignature = false,
}) {
  // 1. Build clientDataJSON
  const clientDataObj = {
    type: 'webauthn.get',
    challenge,
    origin,
    crossOrigin: false,
  };
  const clientDataJSON = Buffer.from(JSON.stringify(clientDataObj));

  // 2. Build authenticatorData (37 bytes minimum)
  const rpIdHash = crypto.createHash('sha256').update(rpId).digest();
  let flags = 0;
  if (userPresent) flags |= 0x01; // Bit 0: UP
  if (userVerified) flags |= 0x04; // Bit 2: UV

  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32BE(signCount, 0);

  const authenticatorData = Buffer.concat([
    rpIdHash,
    Buffer.from([flags]),
    countBuf,
  ]);

  // 3. Compute dataToSign: authenticatorData || sha256(clientDataJSON)
  const clientDataHash = crypto.createHash('sha256').update(clientDataJSON).digest();
  const dataToSign = Buffer.concat([authenticatorData, clientDataHash]);

  // 4. Sign with secp256r1 (P-256) private key
  let signature = crypto.sign('SHA256', dataToSign, keypair.privateKey);

  if (tamperSignature) {
    const tampered = Buffer.from(signature);
    tampered[tampered.length - 1] ^= 0xff;
    signature = tampered;
  }

  return {
    clientDataJSON: toBase64Url(clientDataJSON),
    authenticatorData: toBase64Url(authenticatorData),
    signature: toBase64Url(signature),
  };
}

test('PasskeyAdapter - challenge creation, lifecycle, and replay prevention', () => {
  const adapter = new PasskeyAdapter({ challengeTtlMs: 1000 });

  const challengeInfo = adapter.createChallenge({
    userId: 'user_123',
    action: 'transfer.authorize',
  });

  assert.ok(challengeInfo.challenge);
  assert.ok(challengeInfo.challengeId);
  assert.equal(challengeInfo.action, 'transfer.authorize');

  // Consuming challenge once succeeds
  const consumed = adapter.consumeChallenge(challengeInfo.challenge);
  assert.equal(consumed.userId, 'user_123');

  // Consuming challenge a second time fails (replay protection)
  assert.throws(
    () => adapter.consumeChallenge(challengeInfo.challenge),
    /Unknown or invalid WebAuthn challenge/
  );
});

test('PasskeyAdapter - verifies valid secp256r1 WebAuthn assertion', () => {
  const adapter = new PasskeyAdapter({
    rpId: 'sendam.me',
    origin: 'https://sendam.me',
  });

  // Generate authentic secp256r1 (P-256) keypair
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const rawSpkiDer = kp.publicKey.export({ type: 'spki', format: 'der' });

  const challengeInfo = adapter.createChallenge();

  const assertion = createMockWebAuthnAssertion({
    keypair: kp,
    challenge: challengeInfo.challenge,
  });

  const result = adapter.verifyAssertion({
    clientDataJSON: assertion.clientDataJSON,
    authenticatorData: assertion.authenticatorData,
    signature: assertion.signature,
    publicKey: rawSpkiDer,
    requireUserVerification: true,
  });

  assert.equal(result.verified, true);
  assert.equal(result.userPresent, true);
  assert.equal(result.userVerified, true);
  assert.equal(result.signCount, 1);
});

test('PasskeyAdapter - rejects forged or tampered signatures', () => {
  const adapter = new PasskeyAdapter();
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  const challengeInfo = adapter.createChallenge();

  const assertion = createMockWebAuthnAssertion({
    keypair: kp,
    challenge: challengeInfo.challenge,
    tamperSignature: true,
  });

  assert.throws(
    () => {
      adapter.verifyAssertion({
        clientDataJSON: assertion.clientDataJSON,
        authenticatorData: assertion.authenticatorData,
        signature: assertion.signature,
        publicKey: kp.publicKey,
      });
    },
    InvalidSignatureError
  );
});

test('PasskeyAdapter - enforces biometric User Verification (UV flag)', () => {
  const adapter = new PasskeyAdapter();
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  const challengeInfo = adapter.createChallenge();

  // Assertion without biometric verification (UV = false)
  const assertion = createMockWebAuthnAssertion({
    keypair: kp,
    challenge: challengeInfo.challenge,
    userVerified: false,
  });

  assert.throws(
    () => {
      adapter.verifyAssertion({
        clientDataJSON: assertion.clientDataJSON,
        authenticatorData: assertion.authenticatorData,
        signature: assertion.signature,
        publicKey: kp.publicKey,
        requireUserVerification: true,
      });
    },
    UserVerificationRequiredError
  );
});

test('PasskeyAdapter - supports raw 65-byte uncompressed point public key', () => {
  const adapter = new PasskeyAdapter();
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  // Extract raw 65-byte point (0x04 || X || Y) from SPKI (last 65 bytes)
  const spkiDer = kp.publicKey.export({ type: 'spki', format: 'der' });
  const rawPoint = spkiDer.slice(-65);
  assert.equal(rawPoint.length, 65);
  assert.equal(rawPoint[0], 0x04);

  const challengeInfo = adapter.createChallenge();
  const assertion = createMockWebAuthnAssertion({
    keypair: kp,
    challenge: challengeInfo.challenge,
  });

  const result = adapter.verifyAssertion({
    clientDataJSON: assertion.clientDataJSON,
    authenticatorData: assertion.authenticatorData,
    signature: assertion.signature,
    publicKey: rawPoint,
  });

  assert.equal(result.verified, true);
});

test('PasskeyAdapter - authorizes direct customer custody transfer with Soroban smart wallet payload', async () => {
  const adapter = new PasskeyAdapter();
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  // Soroban smart wallet contract address
  const smartWalletAddress = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

  const challengeInfo = adapter.createChallenge({
    smartWalletAddress,
    action: 'transfer.authorize',
  });

  const assertion = createMockWebAuthnAssertion({
    keypair: kp,
    challenge: challengeInfo.challenge,
  });

  const transferDetails = {
    amount: '100.00',
    asset: 'USDC',
    destination: 'GAAAZ2P5VXQNQ3HAWCF3VTETUR6Z4M46JV2ZQFOJAV323MN66JFAZ4SF',
  };

  const authResult = await adapter.authorizeSelfCustodyTransfer({
    smartWalletAddress,
    publicKey: kp.publicKey,
    passkeyAssertion: assertion,
    transferDetails,
  });

  assert.equal(authResult.authorized, true);
  assert.equal(authResult.smartWalletAuth.smartWalletAddress, smartWalletAddress);
  assert.equal(authResult.smartWalletAuth.authMethod, 'webauthn_secp256r1');
  assert.ok(authResult.smartWalletAuth.signature);
  assert.ok(authResult.smartWalletAuth.authenticatorData);
  assert.ok(authResult.smartWalletAuth.clientDataJSON);
});
