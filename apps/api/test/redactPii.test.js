const { test } = require('node:test');
const assert = require('node:assert/strict');
const { redactString, redactPii } = require('../src/middlewares/redactPii');
const logger = require('../src/utils/logger');

// Built at runtime so no secret-shaped literal sits in the repository.
const SECRET_KEY = `S${'A2B3C4D5E6F7G'.repeat(5).slice(0, 55)}`;

const captureLogs = (fn) => {
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  console.log = (l) => lines.push(l);
  console.warn = (l) => lines.push(l);
  console.error = (l) => lines.push(l);
  try { fn(); } finally { Object.assign(console, originals); }
  return lines;
};

test('Stellar secret keys are redacted from free text', () => {
  assert.equal(SECRET_KEY.length, 56);
  const out = redactString(`import failed for ${SECRET_KEY}, retry`);
  assert.doesNotMatch(out, new RegExp(SECRET_KEY));
  assert.match(out, /\[REDACTED_SECRET_KEY\]/);
});

test('public keys (G...) are not treated as secrets', () => {
  const pub = `G${'A'.repeat(55)}`;
  assert.equal(redactString(pub), pub);
});

test('phone numbers in E.164, Nigerian local and international forms are redacted', () => {
  for (const phone of ['+2348031234567', '+1 (415) 555-2671', '2348031234567', '08031234567']) {
    const out = redactString(`user ${phone} sent funds`);
    assert.ok(!out.includes(phone), `${phone} leaked: ${out}`);
    assert.match(out, /\[REDACTED_PHONE\]/);
  }
});

test('labelled phone numbers are redacted in any format', () => {
  assert.doesNotMatch(redactString('phone=4155552671'), /4155552671/);
  assert.doesNotMatch(redactString('{"msisdn":"4155552671"}'), /4155552671/);
});

test('PINs are redacted in key-value, JSON and prose forms', () => {
  for (const text of ['pin=4821', 'PIN: 4821', '{"pin":"4821"}', 'the PIN is 4821', 'pin 4821']) {
    assert.doesNotMatch(redactString(text), /4821/, text);
  }
});

test('ordinary numbers, amounts and timestamps are left alone', () => {
  const text = 'amount 1500.50 at 1767225600000 ledger 52341877 fee 100';
  assert.equal(redactString(text), text);
});

test('logger redacts secrets and phones in every output stream', () => {
  const lines = captureLogs(() => {
    logger.info(`seed ${SECRET_KEY}`, { phone: '+2348031234567', note: 'call 08031234567' });
    logger.warn('warn', { wa_id: '2348031234567', pin: '4821' });
    logger.error('failed', new Error(`bad key ${SECRET_KEY} for +2348031234567`));
    logger.child({ msisdn: '2348031234567' }).info('child event', { detail: SECRET_KEY });
  });
  assert.equal(lines.length, 4);
  const joined = lines.join('\n');
  assert.doesNotMatch(joined, new RegExp(SECRET_KEY));
  assert.doesNotMatch(joined, /2348031234567|08031234567|4821/);
});

test('logger.sanitize redacts nested phone values and arrays', () => {
  const out = logger.sanitize({ users: [{ phoneNumber: '+2348031234567', name: 'Ada' }], mobile: 8031234567 });
  assert.equal(out.users[0].phoneNumber, '[REDACTED_PHONE]');
  assert.equal(out.users[0].name, 'Ada');
  assert.equal(out.mobile, '[REDACTED_PHONE]');
});

test('middleware exposes a redacted URL without mutating the original', () => {
  const req = { originalUrl: '/api/x?phone=%2B2348031234567&token=abc123&ok=1' };
  let called = false;
  redactPii(req, {}, () => { called = true; });
  assert.ok(called);
  assert.doesNotMatch(req.redactedUrl, /abc123/);
  assert.match(req.redactedUrl, /ok=1/);
  assert.match(req.originalUrl, /abc123/);
});
