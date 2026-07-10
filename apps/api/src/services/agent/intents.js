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
    // format: save ada GABC... or save bob 0x1234...
    // Casing is left as typed — Stellar keys get normalized to uppercase
    // downstream, but forcing case here would corrupt an EVM address (Lisk
    // addresses aren't simply upper/lowercase the way StrKey is).
    if (parts.length === 3) {
      return {
        type: 'SAVE_CONTACT',
        payload: {
          alias: parts[1].toLowerCase(),
          publicKey: parts[2],
        },
      };
    }
    return { type: 'INVALID_SAVE', payload: null };
  }

  if (normalizedText.startsWith('send ')) {
    const parts = trimmedText.split(/\s+/);
    // format: send <amount> <asset> <address-or-name>, e.g. "send 5 xlm ada"
    // or "send 0.01 eth 0x...". Asset is kept as typed (uppercased) — the
    // chain is inferred later from the resolved destination address, not
    // from this keyword, so 'xlm'/'eth' here is just user-facing labeling.
    if (parts.length >= 4) {
      return {
        type: 'SEND',
        payload: {
          amount: parts[1],
          asset: parts[2].toUpperCase(),
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
