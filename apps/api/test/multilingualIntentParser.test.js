const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseRegionalIntent, parseVernacularAmount } = require('../src/voice/intentParser');

describe('Multilingual African Intent Parser (#973)', () => {
  const sample50Phrases = [
    // 1-10: Pidgin & Nigerian English Slang
    { input: 'Send two k to Emeka', expected: { action: 'SEND', amount: 2000, currency: 'NGN', recipient: 'Emeka' } },
    { input: 'dash Amina 10k', expected: { action: 'SEND', amount: 10000, currency: 'NGN', recipient: 'Amina' } },
    { input: 'transfer 5k naira give Chidi', expected: { action: 'SEND', amount: 5000, currency: 'NGN', recipient: 'Chidi' } },
    { input: 'send 2.5k to Blessing', expected: { action: 'SEND', amount: 2500, currency: 'NGN', recipient: 'Blessing' } },
    { input: 'drop 50k for Mama', expected: { action: 'SEND', amount: 50000, currency: 'NGN', recipient: 'Mama' } },
    { input: 'throw 15k to Obi', expected: { action: 'SEND', amount: 15000, currency: 'NGN', recipient: 'Obi' } },
    { input: 'pay 20k naira give Ngozi', expected: { action: 'SEND', amount: 20000, currency: 'NGN', recipient: 'Ngozi' } },
    { input: 'wire 3k to Ahmed', expected: { action: 'SEND', amount: 3000, currency: 'NGN', recipient: 'Ahmed' } },
    { input: 'dash Tunde 1000 naira', expected: { action: 'SEND', amount: 1000, currency: 'NGN', recipient: 'Tunde' } },
    { input: 'send 50 quid to John', expected: { action: 'SEND', amount: 50, currency: 'GBP', recipient: 'John' } },

    // 11-20: Hausa Phrases
    { input: 'Ba Aminu dubu biyar', expected: { action: 'SEND', amount: 5000, currency: 'NGN', recipient: 'Aminu' } },
    { input: 'Aika dubu biyu ga Fatima', expected: { action: 'SEND', amount: 2000, currency: 'NGN', recipient: 'Fatima' } },
    { input: 'Tura dubu goma ga Musa', expected: { action: 'SEND', amount: 10000, currency: 'NGN', recipient: 'Musa' } },
    { input: 'Ba Zainab dari biyar', expected: { action: 'SEND', amount: 500, currency: 'NGN', recipient: 'Zainab' } },
    { input: 'Aika dubu daya ga Aliyu', expected: { action: 'SEND', amount: 1000, currency: 'NGN', recipient: 'Aliyu' } },
    { input: 'Tura dubu uku ga Ibrahim', expected: { action: 'SEND', amount: 3000, currency: 'NGN', recipient: 'Ibrahim' } },
    { input: 'Ba Sani dubu hudu', expected: { action: 'SEND', amount: 4000, currency: 'NGN', recipient: 'Sani' } },
    { input: 'Aika dubu shida ga Maryam', expected: { action: 'SEND', amount: 6000, currency: 'NGN', recipient: 'Maryam' } },
    { input: 'Tura dubu bakwai ga Usman', expected: { action: 'SEND', amount: 7000, currency: 'NGN', recipient: 'Usman' } },
    { input: 'Ba Bilkisu dubu takwas', expected: { action: 'SEND', amount: 8000, currency: 'NGN', recipient: 'Bilkisu' } },

    // 21-30: Yoruba Phrases
    { input: 'Fi egberun meji ranse si Tayo', expected: { action: 'SEND', amount: 2000, currency: 'NGN', recipient: 'Tayo' } },
    { input: 'Fi 2k naira ranse si Bola', expected: { action: 'SEND', amount: 2000, currency: 'NGN', recipient: 'Bola' } },
    { input: 'Gbe 5000 naira fun Ade', expected: { action: 'SEND', amount: 5000, currency: 'NGN', recipient: 'Ade' } },
    { input: 'San egberun marun fun Femi', expected: { action: 'SEND', amount: 5000, currency: 'NGN', recipient: 'Femi' } },
    { input: 'Fi egberun kan ranse si Kunle', expected: { action: 'SEND', amount: 1000, currency: 'NGN', recipient: 'Kunle' } },
    { input: 'Gbe egberun meta fun Segun', expected: { action: 'SEND', amount: 3000, currency: 'NGN', recipient: 'Segun' } },
    { input: 'San 10k fun Bukola', expected: { action: 'SEND', amount: 10000, currency: 'NGN', recipient: 'Bukola' } },
    { input: 'Fi egberun mewaa ranse si Folake', expected: { action: 'SEND', amount: 10000, currency: 'NGN', recipient: 'Folake' } },
    { input: 'Gbe egberun merin fun Yemi', expected: { action: 'SEND', amount: 4000, currency: 'NGN', recipient: 'Yemi' } },
    { input: 'San egberun mefa fun Funke', expected: { action: 'SEND', amount: 6000, currency: 'NGN', recipient: 'Funke' } },

    // 31-40: Swahili Phrases
    { input: 'Tuma elfu mbili kwa Juma', expected: { action: 'SEND', amount: 2000, currency: 'KES', recipient: 'Juma' } },
    { input: 'Lipa elfu moja shillingi kwa Mwangi', expected: { action: 'SEND', amount: 1000, currency: 'KES', recipient: 'Mwangi' } },
    { input: 'Hamisha mia tano kwa Asha', expected: { action: 'SEND', amount: 500, currency: 'KES', recipient: 'Asha' } },
    { input: 'Tuma elfu tano kwa Kipchoge', expected: { action: 'SEND', amount: 5000, currency: 'KES', recipient: 'Kipchoge' } },
    { input: 'Lipa 500 bob kwa Wanjiku', expected: { action: 'SEND', amount: 500, currency: 'KES', recipient: 'Wanjiku' } },
    { input: 'Hamisha elfu kumi kwa Omondi', expected: { action: 'SEND', amount: 10000, currency: 'KES', recipient: 'Omondi' } },
    { input: 'Tuma 3000 shillings kwa Kamau', expected: { action: 'SEND', amount: 3000, currency: 'KES', recipient: 'Kamau' } },
    { input: 'Lipa elfu tatu kwa Njeri', expected: { action: 'SEND', amount: 3000, currency: 'KES', recipient: 'Njeri' } },
    { input: 'Tuma mia mbili kwa Otieno', expected: { action: 'SEND', amount: 200, currency: 'KES', recipient: 'Otieno' } },
    { input: 'Hamisha elfu nne kwa Mutua', expected: { action: 'SEND', amount: 4000, currency: 'KES', recipient: 'Mutua' } },

    // 41-50: Ghanaian English / Cedis & Crypto / USD Phrases
    { input: 'Transfer 50 cedis to Kofi', expected: { action: 'SEND', amount: 50, currency: 'GHS', recipient: 'Kofi' } },
    { input: 'Send 100 cedi give Kwame', expected: { action: 'SEND', amount: 100, currency: 'GHS', recipient: 'Kwame' } },
    { input: 'dash Ama 20 cedis', expected: { action: 'SEND', amount: 20, currency: 'GHS', recipient: 'Ama' } },
    { input: 'pay 500 ghs to Abena', expected: { action: 'SEND', amount: 500, currency: 'GHS', recipient: 'Abena' } },
    { input: 'transfer 250 cedis to Yaw', expected: { action: 'SEND', amount: 250, currency: 'GHS', recipient: 'Yaw' } },
    { input: 'Send 100 dollars to Grace', expected: { action: 'SEND', amount: 100, currency: 'USD', recipient: 'Grace' } },
    { input: 'Pay 25 bucks to Dave', expected: { action: 'SEND', amount: 25, currency: 'USD', recipient: 'Dave' } },
    { input: 'transfer 50 usdc to Alice', expected: { action: 'SEND', amount: 50, currency: 'USDC', recipient: 'Alice' } },
    { input: 'send 150 xlm to Bob', expected: { action: 'SEND', amount: 150, currency: 'XLM', recipient: 'Bob' } },
    { input: 'Dash Akosua 75 cedis', expected: { action: 'SEND', amount: 75, currency: 'GHS', recipient: 'Akosua' } },
  ];

  test('successfully parses all 50 sample regional phrases into structured JSON', () => {
    assert.equal(sample50Phrases.length, 50, 'Exactly 50 sample phrases must be evaluated');

    sample50Phrases.forEach(({ input, expected }, idx) => {
      const parsed = parseRegionalIntent(input);
      assert.ok(parsed, `Failed to parse phrase #${idx + 1}: "${input}"`);
      assert.equal(parsed.action, expected.action, `Phrase #${idx + 1} "${input}": action mismatch`);
      assert.equal(parsed.amount, expected.amount, `Phrase #${idx + 1} "${input}": amount mismatch`);
      assert.equal(parsed.currency, expected.currency, `Phrase #${idx + 1} "${input}": currency mismatch`);
      assert.equal(parsed.recipient, expected.recipient, `Phrase #${idx + 1} "${input}": recipient mismatch`);
    });
  });

  test('handles memos within regional phrases', () => {
    const withMemo = parseRegionalIntent('Send two k to Emeka with memo: groceries');
    assert.ok(withMemo);
    assert.equal(withMemo.amount, 2000);
    assert.equal(withMemo.recipient, 'Emeka');
    assert.equal(withMemo.memo, 'groceries');
  });

  test('parseVernacularAmount handles standalone numbers and slang tokens', () => {
    assert.equal(parseVernacularAmount(['2k']), 2000);
    assert.equal(parseVernacularAmount(['2.5k']), 2500);
    assert.equal(parseVernacularAmount(['50']), 50);
    assert.equal(parseVernacularAmount(['two', 'k']), 2000);
    assert.equal(parseVernacularAmount(['dubu', 'biyar']), 5000);
    assert.equal(parseVernacularAmount(['elfu', 'mbili']), 2000);
    assert.equal(parseVernacularAmount(['egberun', 'meji']), 2000);
  });
});
