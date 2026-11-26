/**
 * Natural Language Intent Parser for Multilingual African Corridors
 * Supports Pidgin, Hausa, Yoruba, Swahili, Ghanaian English/Pidgin, and Standard English.
 *
 * Recognizes regional slang, currency keywords (k, quid, dubu, naira, cedis, bob, etc.),
 * number words, and recipient contact names.
 */

const NUMBER_WORDS = {
  // English
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000, million: 1000000,

  // Hausa
  daya: 1, biyu: 2, uku: 3, hudu: 4, biyar: 5,
  shida: 6, bakwai: 7, takwas: 8, tara: 9, goma: 10,
  ashirin: 20, talatin: 30, 'arba\'in': 40, arbain: 40, hamsin: 50,
  tamanin: 80, dari: 100, dubu: 1000, miliyan: 1000000,

  // Yoruba
  okan: 1, kan: 1, meji: 2, eji: 2, meta: 3, eta: 3,
  merin: 4, erin: 4, marun: 5, arun: 5, mefa: 6, efa: 6,
  meje: 7, eje: 7, mejo: 8, ejo: 8, mesan: 9, esan: 9,
  mewaa: 10, mewa: 10, ewa: 10, ogun: 20, ogbon: 30, ogoji: 40,
  aadota: 50, adota: 50, ogorun: 100, egberun: 1000,

  // Swahili
  moja: 1, mbili: 2, tatu: 3, nne: 4, tano: 5,
  sita: 6, saba: 7, nane: 8, tisa: 9, kumi: 10,
  ishirini: 20, thelathini: 30, arobaini: 40, hamsini: 50,
  mia: 100, elfu: 1000, milioni: 1000000,
};

const CURRENCY_MAP = {
  // Nigeria
  naira: 'NGN',
  nairas: 'NGN',
  ngn: 'NGN',
  kobo: 'NGN',
  dubu: 'NGN', // Hausa default

  // Ghana
  cedi: 'GHS',
  cedis: 'GHS',
  ghs: 'GHS',
  pesewa: 'GHS',
  pesewas: 'GHS',

  // Kenya / East Africa
  shilling: 'KES',
  shillings: 'KES',
  shilingi: 'KES',
  kes: 'KES',
  bob: 'KES',

  // US / Global
  usd: 'USD',
  dollar: 'USD',
  dollars: 'USD',
  bucks: 'USD',
  buck: 'USD',

  // Crypto / Native
  xlm: 'XLM',
  usdc: 'USDC',

  // UK
  quid: 'GBP',
  pound: 'GBP',
  pounds: 'GBP',
};

// Words that indicate an action to transfer / send
const SEND_VERBS = [
  // English / Pidgin
  'send', 'transfer', 'pay', 'dash', 'give', 'wire', 'drop', 'throw',
  // Hausa
  'ba', 'bada', 'aika', 'tura',
  // Yoruba
  'fi', 'gbe', 'san', 'ranse',
  // Swahili
  'tuma', 'lipa', 'hamisha', 'peana',
];

/**
 * Parses numeric text that may include numbers, words ("two k", "dubu biyar", "elfu mbili"),
 * or multipliers like "5k", "2.5k", "10k".
 */
function parseVernacularAmount(rawTokens) {
  if (!rawTokens || rawTokens.length === 0) return null;

  // Handle strings like "2k", "2.5k", "50k", "1m"
  if (rawTokens.length === 1 && typeof rawTokens[0] === 'string') {
    const single = rawTokens[0].toLowerCase().trim();
    const kMatch = single.match(/^([\d.]+)\s*k$/i);
    if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1000);

    const mMatch = single.match(/^([\d.]+)\s*m$/i);
    if (mMatch) return Math.round(parseFloat(mMatch[1]) * 1000000);

    const numMatch = single.match(/^[\d.]+$/);
    if (numMatch) return parseFloat(single);
  }

  let total = 0;
  let current = 0;
  let foundAny = false;

  for (let i = 0; i < rawTokens.length; i++) {
    const token = String(rawTokens[i]).toLowerCase().replace(/,/g, '').trim();
    if (!token) continue;

    // Check shorthand like "2k"
    const kMatch = token.match(/^([\d.]+)\s*k$/i);
    if (kMatch) {
      const val = parseFloat(kMatch[1]) * 1000;
      current += val;
      foundAny = true;
      continue;
    }

    // Direct number
    const num = parseFloat(token);
    if (!isNaN(num) && /^\d+(\.\d+)?$/.test(token)) {
      current += num;
      foundAny = true;
      continue;
    }

    // Word representation
    const wordVal = NUMBER_WORDS[token];
    if (wordVal !== undefined) {
      foundAny = true;
      if (token === 'k' || token === 'thousand' || token === 'dubu' || token === 'egberun' || token === 'elfu') {
        if (current === 0) {
          current = 1000;
        } else {
          current *= 1000;
        }
        total += current;
        current = 0;
      } else if (token === 'hundred' || token === 'dari' || token === 'ogorun' || token === 'mia') {
        if (current === 0) {
          current = 100;
        } else {
          current *= 100;
        }
      } else if (token === 'million' || token === 'miliyan' || token === 'milioni') {
        if (current === 0) {
          current = 1000000;
        } else {
          current *= 1000000;
        }
        total += current;
        current = 0;
      } else {
        // e.g. "dubu biyar" (Hausa: thousand five -> 5000)
        // e.g. "elfu mbili" (Swahili: thousand two -> 2000)
        // e.g. "egberun meji" (Yoruba: thousand two -> 2000)
        // If the preceding token was a thousand unit ("dubu", "elfu", "egberun"), multiply!
        const prev = i > 0 ? String(rawTokens[i - 1]).toLowerCase() : '';
        if (['dubu', 'elfu', 'egberun'].includes(prev)) {
          // Replace previous 1000 with 1000 * wordVal
          total -= 1000;
          total += 1000 * wordVal;
        } else if (['dari', 'mia', 'ogorun'].includes(prev)) {
          total -= 100;
          total += 100 * wordVal;
        } else {
          current += wordVal;
        }
      }
    } else if (token === 'k') {
      // Shorthand "k" as separate word, e.g. "two k"
      if (current === 0) current = 1;
      current *= 1000;
      total += current;
      current = 0;
      foundAny = true;
    }
  }

  total += current;
  return foundAny ? total : null;
}

/**
 * Extracts memo if present ("with memo: rent", "memo text: groceries", etc.)
 */
function extractMemo(text) {
  const memoMatch = text.match(/(?:\bwith\s+memo\b|\bmemo\b)(?::|\s+)?(?:(text|id|hash|return):)?\s*([^\s]+)/i);
  if (memoMatch) {
    return {
      memo: memoMatch[2],
      memoType: memoMatch[1] ? memoMatch[1].toLowerCase() : 'text',
      cleanedText: text.replace(memoMatch[0], '').trim(),
    };
  }
  return { memo: undefined, memoType: undefined, cleanedText: text };
}

/**
 * Primary intent parser function.
 * Parses input text and returns structured object:
 * { action: 'SEND', amount: 2000, currency: 'NGN', recipient: 'Emeka' }
 */
function parseRegionalIntent(input) {
  if (!input || typeof input !== 'string') return null;

  const raw = input.trim();
  const { memo, memoType, cleanedText } = extractMemo(raw);
  const normalized = cleanedText.trim();

  // Pattern A: Hausa patterns
  // "Ba Aminu dubu biyar", "Ba Aminu 5000", "Aika dubu biyu ga Fatima", "Tura dubu goma ga Musa"
  const hausaBaMatch = normalized.match(/^(?:ba|bada)\s+([a-zA-Z0-9_\-\s]+?)\s+(dubu\s+[a-z]+|dari\s+[a-z]+|\d+k?|\d+(?:\.\d+)?(?:\s*naira)?)(?:\s+naira)?$/i);
  if (hausaBaMatch) {
    const recipient = hausaBaMatch[1].trim();
    const amountTokens = hausaBaMatch[2].trim().split(/\s+/);
    const amount = parseVernacularAmount(amountTokens);
    if (amount !== null && recipient) {
      return {
        action: 'SEND',
        amount,
        currency: 'NGN',
        recipient,
        language: 'hausa',
        ...(memo ? { memo, memoType } : {}),
      };
    }
  }

  const hausaAikaMatch = normalized.match(/^(?:aika|tura)\s+(.+?)\s+(?:ga|wa|ma)\s+([a-zA-Z0-9_-]+)$/i);
  if (hausaAikaMatch) {
    const amountTokens = hausaAikaMatch[1].trim().split(/\s+/);
    const recipient = hausaAikaMatch[2].trim();
    const amount = parseVernacularAmount(amountTokens);
    if (amount !== null && recipient) {
      return {
        action: 'SEND',
        amount,
        currency: 'NGN',
        recipient,
        language: 'hausa',
        ...(memo ? { memo, memoType } : {}),
      };
    }
  }

  // Pattern B: Yoruba patterns
  // "Fi egberun meji ranse si Tayo", "Fi 2k naira ranse si Bola", "Gbe 5000 naira fun Ade", "San egberun marun fun Femi"
  const yorubaFiMatch = normalized.match(/^fi\s+(.+?)\s+ranse\s+si\s+([a-zA-Z0-9_-]+)$/i);
  if (yorubaFiMatch) {
    const amountStr = yorubaFiMatch[1].replace(/\bnaira\b/gi, '').trim();
    const recipient = yorubaFiMatch[2].trim();
    const amount = parseVernacularAmount(amountStr.split(/\s+/));
    if (amount !== null && recipient) {
      return {
        action: 'SEND',
        amount,
        currency: 'NGN',
        recipient,
        language: 'yoruba',
        ...(memo ? { memo, memoType } : {}),
      };
    }
  }

  const yorubaGbeMatch = normalized.match(/^(?:gbe|san|fi)\s+(.+?)\s+fun\s+([a-zA-Z0-9_-]+)$/i);
  if (yorubaGbeMatch) {
    const amountStr = yorubaGbeMatch[1].replace(/\bnaira\b/gi, '').trim();
    const recipient = yorubaGbeMatch[2].trim();
    const amount = parseVernacularAmount(amountStr.split(/\s+/));
    if (amount !== null && recipient) {
      return {
        action: 'SEND',
        amount,
        currency: 'NGN',
        recipient,
        language: 'yoruba',
        ...(memo ? { memo, memoType } : {}),
      };
    }
  }

  // Pattern C: Swahili patterns
  // "Tuma elfu mbili kwa Juma", "Lipa elfu moja shillingi kwa Mwangi", "Hamisha mia tano kwa Asha"
  const swahiliMatch = normalized.match(/^(?:tuma|lipa|hamisha|peana)\s+(.+?)\s+kwa\s+([a-zA-Z0-9_-]+)$/i);
  if (swahiliMatch) {
    let amountStr = swahiliMatch[1].trim();
    let currency = 'KES';
    for (const [kw, curr] of Object.entries(CURRENCY_MAP)) {
      const reg = new RegExp(`\\b${kw}\\b`, 'i');
      if (reg.test(amountStr)) {
        currency = curr;
        amountStr = amountStr.replace(reg, '').trim();
        break;
      }
    }
    const recipient = swahiliMatch[2].trim();
    const amount = parseVernacularAmount(amountStr.split(/\s+/));
    if (amount !== null && recipient) {
      return {
        action: 'SEND',
        amount,
        currency,
        recipient,
        language: 'swahili',
        ...(memo ? { memo, memoType } : {}),
      };
    }
  }

  // Pattern D: English, Nigerian Pidgin, Ghanaian English
  // "Send two k to Emeka", "dash Amina 10k", "transfer 5k naira give Chidi", "pay 50 cedis to Kofi", "send 50 quid to John"
  const englishRegex = /^(?:send|transfer|pay|dash|give|wire|drop|throw)\s+(.+?)\s+(?:to|give|for)\s+(.+)$/i;
  const engMatch = normalized.match(englishRegex);
  if (engMatch) {
    let amountPart = engMatch[1].trim();
    const recipient = engMatch[2].trim();

    let detectedCurrency = null;
    for (const [kw, curr] of Object.entries(CURRENCY_MAP)) {
      const reg = new RegExp(`\\b${kw}\\b`, 'i');
      if (reg.test(amountPart)) {
        detectedCurrency = curr;
        amountPart = amountPart.replace(reg, '').trim();
        break;
      }
    }

    const amount = parseVernacularAmount(amountPart.split(/\s+/));
    if (amount !== null && recipient) {
      // Default currency determination if not specified
      if (!detectedCurrency) {
        // If "k" or "dash" or Pidgin context, default to NGN, otherwise NGN as corridor default
        detectedCurrency = 'NGN';
      }
      return {
        action: 'SEND',
        amount,
        currency: detectedCurrency,
        recipient,
        language: 'english_pidgin',
        ...(memo ? { memo, memoType } : {}),
      };
    }
  }

  // Pattern E: Inverted format (e.g. "Pay Kofi 50 cedis", "Dash Emeka 2k", "Send Amina 5000 naira")
  const invertedRegex = /^(?:send|transfer|pay|dash|give)\s+([a-zA-Z0-9_-]+)\s+(.+)$/i;
  const invMatch = normalized.match(invertedRegex);
  if (invMatch) {
    const candidateRecipient = invMatch[1].trim();
    let rest = invMatch[2].trim();

    let detectedCurrency = null;
    for (const [kw, curr] of Object.entries(CURRENCY_MAP)) {
      const reg = new RegExp(`\\b${kw}\\b`, 'i');
      if (reg.test(rest)) {
        detectedCurrency = curr;
        rest = rest.replace(reg, '').trim();
        break;
      }
    }

    const amount = parseVernacularAmount(rest.split(/\s+/));
    if (amount !== null && candidateRecipient && !NUMBER_WORDS[candidateRecipient.toLowerCase()]) {
      if (!detectedCurrency) detectedCurrency = 'NGN';
      return {
        action: 'SEND',
        amount,
        currency: detectedCurrency,
        recipient: candidateRecipient,
        language: 'english_pidgin',
        ...(memo ? { memo, memoType } : {}),
      };
    }
  }

  return null;
}

module.exports = {
  parseRegionalIntent,
  parseVernacularAmount,
  NUMBER_WORDS,
  CURRENCY_MAP,
  SEND_VERBS,
};
