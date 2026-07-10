const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

// transaction.service (pulled in transitively by the handler) validates the
// encryption key at require-time, so set it before importing.
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

const { resolveRecipient, isPendingSendExpired } = require('../src/services/agent/handler');

const VALID_KEY = 'GA6UY5O4LMTQLBFXIQXOGM5JK4GNAVXHKYYXKSCIXVHCJ7ETQW55EAAZ';
const VALID_LISK_ADDRESS = ethers.Wallet.createRandom().address;

test('resolves a raw Stellar public key directly (uppercased), no alias', () => {
  const result = resolveRecipient({ contacts: [] }, VALID_KEY.toLowerCase());
  assert.equal(result.destination, VALID_KEY);
  assert.equal(result.alias, null);
  assert.equal(result.chain, 'stellar');
});

test('resolves a raw Lisk address directly (case preserved), no alias', () => {
  const result = resolveRecipient({ contacts: [] }, VALID_LISK_ADDRESS);
  assert.equal(result.destination, VALID_LISK_ADDRESS);
  assert.equal(result.alias, null);
  assert.equal(result.chain, 'lisk');
});

test('resolves a saved Stellar alias to its stored public key and chain', () => {
  const user = { contacts: [{ alias: 'ada', publicKey: VALID_KEY, chain: 'stellar' }] };
  const result = resolveRecipient(user, 'Ada');
  assert.equal(result.destination, VALID_KEY);
  assert.equal(result.alias, 'ada');
  assert.equal(result.chain, 'stellar');
});

test('resolves a saved Lisk alias to its stored address and chain', () => {
  const user = { contacts: [{ alias: 'bob', publicKey: VALID_LISK_ADDRESS, chain: 'lisk' }] };
  const result = resolveRecipient(user, 'Bob');
  assert.equal(result.destination, VALID_LISK_ADDRESS);
  assert.equal(result.alias, 'bob');
  assert.equal(result.chain, 'lisk');
});

test('a contact saved before the chain field existed defaults to stellar', () => {
  const user = { contacts: [{ alias: 'legacy', publicKey: VALID_KEY }] };
  const result = resolveRecipient(user, 'legacy');
  assert.equal(result.chain, 'stellar');
});

test('returns no destination for an unknown alias', () => {
  const result = resolveRecipient({ contacts: [] }, 'nobody');
  assert.equal(result.destination, null);
  assert.equal(result.alias, 'nobody');
  assert.equal(result.chain, null);
});

test('tolerates a user with no contacts array', () => {
  const result = resolveRecipient({}, 'ghost');
  assert.equal(result.destination, null);
  assert.equal(result.alias, 'ghost');
});

test('a pending send with no timestamp is treated as expired', () => {
  assert.equal(isPendingSendExpired({}), true);
});

test('a fresh pending send is not expired; an old one is', () => {
  assert.equal(isPendingSendExpired({ requestedAt: new Date() }), false);
  const old = new Date(Date.now() - 11 * 60 * 1000); // 11 min ago, TTL is 10
  assert.equal(isPendingSendExpired({ requestedAt: old }), true);
});
