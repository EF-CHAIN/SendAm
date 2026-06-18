// Classifies an inbound WhatsApp message into an intent the handler can
// dispatch on. Keep this purely about recognising intent + extracting a
// payload; all side effects belong in the handlers. New flows (e.g. buy,
// withdraw, swap) are added here as new intent types, then wired into the
// handler's dispatch map.

const parseIntent = (text) => {
  const trimmedText = text.trim();
  const normalizedText = trimmedText.toLowerCase();

  if (normalizedText === 'hi' || normalizedText === 'hello') {
    return { type: 'GREETING', payload: null };
  }

  if (normalizedText === 'help') {
    return { type: 'HELP', payload: null };
  }

  if (normalizedText === 'yes' || normalizedText === 'confirm') {
    return { type: 'CONFIRM_SEND', payload: null };
  }

  if (normalizedText === 'no' || normalizedText === 'cancel') {
    return { type: 'CANCEL_SEND', payload: null };
  }

  if (normalizedText === 'create wallet') {
    return { type: 'CREATE_WALLET', payload: null };
  }

  if (normalizedText === 'balance') {
    return { type: 'BALANCE', payload: null };
  }

  if (normalizedText === 'fund' || normalizedText === 'fund wallet') {
    return { type: 'FUND_WALLET', payload: null };
  }

  if (normalizedText === 'contacts' || normalizedText === 'list contacts') {
    return { type: 'LIST_CONTACTS', payload: null };
  }

  if (normalizedText.startsWith('save ')) {
    const parts = trimmedText.split(/\s+/);
    // format: save ada GABC...
    if (parts.length === 3) {
      return {
        type: 'SAVE_CONTACT',
        payload: {
          alias: parts[1].toLowerCase(),
          publicKey: parts[2].toUpperCase(),
        },
      };
    }
    return { type: 'INVALID_SAVE', payload: null };
  }

  if (normalizedText.startsWith('send ')) {
    const parts = trimmedText.split(/\s+/);
    // format: send 5 xlm GABC... or send 5 xlm ada
    if (parts.length >= 4 && parts[2].toLowerCase() === 'xlm') {
      return {
        type: 'SEND',
        payload: {
          amount: parts[1],
          asset: 'XLM',
          recipient: parts[3],
        },
      };
    }
    return { type: 'INVALID_SEND', payload: null };
  }

  return { type: 'UNKNOWN', payload: null };
};

module.exports = {
  parseIntent,
};
