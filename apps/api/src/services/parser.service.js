const parseCommand = (text) => {
  const normalizedText = text.trim().toLowerCase();

  if (normalizedText === 'hi' || normalizedText === 'hello') {
    return { type: 'GREETING', payload: null };
  }

  if (normalizedText === 'help') {
    return { type: 'HELP', payload: null };
  }

  if (normalizedText === 'create wallet') {
    return { type: 'CREATE_WALLET', payload: null };
  }

  if (normalizedText === 'balance') {
    return { type: 'BALANCE', payload: null };
  }

  if (normalizedText.startsWith('send ')) {
    const parts = normalizedText.split(' ');
    // format: send 5 xlm GABC...
    if (parts.length >= 4 && parts[2] === 'xlm') {
      const amount = parts[1];
      const destination = parts[3].toUpperCase(); // Stellar public keys are uppercase
      return { 
        type: 'SEND_XLM', 
        payload: { amount, destination } 
      };
    }
    return { type: 'INVALID_SEND', payload: null };
  }

  return { type: 'UNKNOWN', payload: null };
};

module.exports = {
  parseCommand
};
