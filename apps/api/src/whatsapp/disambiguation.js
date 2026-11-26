const { sendMetaMessage } = require('../services/whatsappMedia');
const config = require('../config/env');
const logger = require('../utils/logger');

const KNOWN_CURRENCIES = [
  'usd', 'dollar', 'dollars', 'bucks', 'buck',
  'ngn', 'naira', 'kobo',
  'ghs', 'cedi', 'cedis', 'pesewa', 'pesewas',
  'kes', 'shilling', 'shillings', 'shilingi', 'bob',
  'xlm', 'usdc',
  'eur', 'euro', 'euros',
  'gbp', 'pound', 'pounds', 'quid',
];

const DISAMBIGUATION_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Checks if input is an ambiguous payment intent lacking explicit currency.
 * e.g. "Send 50", "pay 50 to Kofi", "transfer 100 to Emeka"
 */
function detectAmbiguousIntent(text) {
  if (!text || typeof text !== 'string') return null;
  const normalized = text.trim();

  // Check if text starts with send/pay/transfer/dash
  const sendMatch = normalized.match(/^(?:send|pay|transfer|dash)\s+([\d.]+)(?:\s+(?:to\s+)?(.+))?$/i);
  if (!sendMatch) return null;

  const rawAmount = sendMatch[1];
  const rest = sendMatch[2] ? sendMatch[2].trim() : '';

  // Check if any word in rest is an explicit currency
  const words = rest.toLowerCase().split(/\s+/).filter(Boolean);
  const firstWord = words[0];

  if (firstWord && KNOWN_CURRENCIES.includes(firstWord)) {
    // Explicit currency is present, not ambiguous
    return null;
  }

  // Check if any other word in rest is an explicit currency
  const hasCurrency = words.some((w) => KNOWN_CURRENCIES.includes(w));
  if (hasCurrency) {
    return null;
  }

  const recipient = rest || null;

  return {
    isAmbiguous: true,
    amount: rawAmount,
    recipient,
  };
}

/**
 * Builds corridor disambiguation options for an ambiguous amount.
 * Example for 50: [50 USD ($)], [50,000 NGN (₦)], [50 GHS (₵)]
 */
function buildDisambiguationOptions(amount) {
  const num = parseFloat(amount) || 50;
  // Colloquial NGN representation: 50 -> 50,000 NGN (or 1k multiplier for USD equivalent parity)
  const ngnAmount = num < 500 ? num * 1000 : num;

  return [
    {
      index: 1,
      id: 'USD',
      currency: 'USD',
      amount: String(num),
      label: `${num} USD ($)`,
    },
    {
      index: 2,
      id: 'NGN',
      currency: 'NGN',
      amount: String(ngnAmount),
      label: `${ngnAmount.toLocaleString()} NGN (₦)`,
    },
    {
      index: 3,
      id: 'GHS',
      currency: 'GHS',
      amount: String(num),
      label: `${num} GHS (₵)`,
    },
  ];
}

/**
 * Formats user-facing text prompt for disambiguation.
 */
function formatDisambiguationPrompt(amount, options) {
  const choices = options
    .map((opt) => `${opt.index}. [${opt.label}]`)
    .join('\n');

  return `Which currency and corridor did you mean for ${amount}?\n\n${choices}\n\nReply with 1, 2, or 3, or "no" to cancel.`;
}

/**
 * Sends disambiguation clarification dialog to the user and sets state.
 */
async function sendDisambiguationPrompt({
  phoneNumber,
  user,
  ambiguousIntent,
  notify,
  db,
}) {
  const options = buildDisambiguationOptions(ambiguousIntent.amount);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DISAMBIGUATION_TTL_MS);

  const pendingSend = {
    version: 1,
    step: 'AWAITING_DISAMBIGUATION',
    ambiguousAmount: String(ambiguousIntent.amount),
    recipient: ambiguousIntent.recipient,
    options,
    requestedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  await db.user.update({
    where: { id: user.id },
    data: { pendingSend },
  });

  const promptText = formatDisambiguationPrompt(ambiguousIntent.amount, options);

  // Try WhatsApp interactive quick buttons if Meta transport is active
  if (config.messageTransport === 'meta') {
    try {
      await sendMetaMessage(
        phoneNumber,
        'interactive',
        {
          type: 'button',
          body: { text: `Which currency and corridor did you mean for ${ambiguousIntent.amount}?` },
          action: {
            buttons: options.map((opt) => ({
              type: 'reply',
              reply: {
                id: `disambiguate:${opt.id}`,
                title: opt.label.slice(0, 20),
              },
            })),
          },
        },
        AbortSignal.timeout(3000)
      );
      return;
    } catch (_err) {
      logger.warn('whatsapp_interactive_disambiguation_failed');
    }
  }

  // Fallback to text menu
  await notify(phoneNumber, promptText);
}

/**
 * Handles user reply when state is AWAITING_DISAMBIGUATION.
 */
async function handleDisambiguationReply({
  phoneNumber,
  user,
  text,
  notify,
  db,
  requestConfirmation,
}) {
  const pending = user.pendingSend;
  if (!pending || pending.step !== 'AWAITING_DISAMBIGUATION') return false;

  const lowered = String(text || '').trim().toLowerCase();

  if (lowered === 'no' || lowered === 'cancel') {
    await db.user.update({
      where: { id: user.id },
      data: { pendingSend: null },
    });
    await notify(phoneNumber, 'Payment cancelled.');
    return true;
  }

  const options = pending.options || buildDisambiguationOptions(pending.ambiguousAmount);

  let selected = null;

  // Check numeric index: "1", "2", "3"
  const idx = parseInt(lowered, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= options.length) {
    selected = options[idx - 1];
  } else if (lowered.startsWith('disambiguate:')) {
    const cur = lowered.split(':')[1]?.toUpperCase();
    selected = options.find((o) => o.currency === cur);
  } else {
    // Check currency code in reply: "usd", "ngn", "ghs"
    selected = options.find(
      (o) => lowered.includes(o.currency.toLowerCase()) || lowered.includes(o.label.toLowerCase())
    );
  }

  if (!selected) {
    await notify(
      phoneNumber,
      `Please select a valid option (1, 2, or 3) from the choices above, or reply "no" to cancel.`
    );
    return true;
  }

  // Resolved intent
  const resolvedIntent = {
    amount: selected.amount,
    asset: selected.currency,
    recipient: pending.recipient,
  };

  // Clear disambiguation state
  await db.user.update({
    where: { id: user.id },
    data: { pendingSend: null },
  });

  if (resolvedIntent.recipient) {
    // Proceed to create quote and confirmation with unambiguous currency
    await requestConfirmation({
      phoneNumber,
      user,
      intent: resolvedIntent,
      notify,
      db,
    });
  } else {
    // Recipient was not provided, ask for recipient
    await db.user.update({
      where: { id: user.id },
      data: {
        pendingSend: {
          version: 1,
          step: 'AWAITING_RECIPIENT',
          amount: resolvedIntent.amount,
          asset: resolvedIntent.asset,
          requestedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + DISAMBIGUATION_TTL_MS).toISOString(),
        },
      },
    });

    await notify(
      phoneNumber,
      `Selected ${selected.label}. Who would you like to send this to? (Reply with recipient contact name, phone number, or Stellar address)`
    );
  }

  return true;
}

module.exports = {
  detectAmbiguousIntent,
  buildDisambiguationOptions,
  formatDisambiguationPrompt,
  sendDisambiguationPrompt,
  handleDisambiguationReply,
};
