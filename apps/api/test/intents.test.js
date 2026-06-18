const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseIntent } = require('../src/services/agent/intents');

test('greetings', () => {
  assert.equal(parseIntent('hi').type, 'GREETING');
  assert.equal(parseIntent('Hello').type, 'GREETING');
  assert.equal(parseIntent('  HELLO  ').type, 'GREETING');
});

test('simple commands are case- and whitespace-insensitive', () => {
  assert.equal(parseIntent('help').type, 'HELP');
  assert.equal(parseIntent('Create Wallet').type, 'CREATE_WALLET');
  assert.equal(parseIntent('  balance ').type, 'BALANCE');
  assert.equal(parseIntent('contacts').type, 'LIST_CONTACTS');
  assert.equal(parseIntent('list contacts').type, 'LIST_CONTACTS');
});

test('fund command (new recovery path)', () => {
  assert.equal(parseIntent('fund').type, 'FUND_WALLET');
  assert.equal(parseIntent('FUND WALLET').type, 'FUND_WALLET');
});

test('confirm and cancel', () => {
  assert.equal(parseIntent('yes').type, 'CONFIRM_SEND');
  assert.equal(parseIntent('confirm').type, 'CONFIRM_SEND');
  assert.equal(parseIntent('no').type, 'CANCEL_SEND');
  assert.equal(parseIntent('cancel').type, 'CANCEL_SEND');
});

test('save contact: valid format extracts alias + public key', () => {
  const result = parseIntent('save Ada GABC123');
  assert.equal(result.type, 'SAVE_CONTACT');
  assert.equal(result.payload.alias, 'ada');
  assert.equal(result.payload.publicKey, 'GABC123');
});

test('save contact: wrong arity is INVALID_SAVE', () => {
  assert.equal(parseIntent('save ada').type, 'INVALID_SAVE');
  assert.equal(parseIntent('save ada GABC extra').type, 'INVALID_SAVE');
});

test('send: to a public key', () => {
  const result = parseIntent('send 5 xlm GABC123');
  assert.equal(result.type, 'SEND');
  assert.deepEqual(result.payload, { amount: '5', asset: 'XLM', recipient: 'GABC123' });
});

test('send: to a saved alias keeps recipient casing for later resolution', () => {
  const result = parseIntent('send 2.5 XLM ada');
  assert.equal(result.type, 'SEND');
  assert.equal(result.payload.amount, '2.5');
  assert.equal(result.payload.recipient, 'ada');
});

test('send: missing asset keyword is INVALID_SEND', () => {
  assert.equal(parseIntent('send 5 ada').type, 'INVALID_SEND');
  assert.equal(parseIntent('send 5').type, 'INVALID_SEND');
});

test('unrecognised text is UNKNOWN', () => {
  assert.equal(parseIntent('what is my fortune').type, 'UNKNOWN');
  assert.equal(parseIntent('').type, 'UNKNOWN');
});
