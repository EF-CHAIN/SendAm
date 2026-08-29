const validateWebhookEnvelope = (body) => {
  if (!body || typeof body !== 'object') {
    return { valid: false, reason: 'Payload must be a non-null object' };
  }
  if (body.object !== 'whatsapp_business_account') {
    return { valid: false, reason: 'Root object must be whatsapp_business_account' };
  }
  if (!Array.isArray(body.entry) || body.entry.length === 0) {
    return { valid: false, reason: 'entry must be a non-empty array' };
  }
  if (body.entry.length > 50) {
    return { valid: false, reason: 'entry array exceeds maximum length of 50' };
  }
  for (const entry of body.entry) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.changes) || entry.changes.length === 0) {
      return { valid: false, reason: 'entry must contain a non-empty changes array' };
    }
  }
  return { valid: true };
};

const validateInboundMessage = (message) => {
  if (!message || typeof message !== 'object') {
    return { valid: false, reason: 'Message must be a non-null object' };
  }
  if (typeof message.id !== 'string' || !message.id.trim() || message.id.length > 256) {
    return { valid: false, reason: 'Message id must be a valid non-empty string (<= 256 chars)' };
  }
  if (typeof message.from !== 'string' || !message.from.trim()) {
    return { valid: false, reason: 'Message from must be a valid sender phone string' };
  }
  if (message.timestamp !== undefined && message.timestamp !== null) {
    const str = String(message.timestamp).trim();
    if (str === '' || Number.isNaN(Number(str))) {
      return { valid: false, reason: 'Message timestamp must be a valid unix timestamp' };
    }
  }
  if (typeof message.type !== 'string') {
    return { valid: false, reason: 'Message type must be a string' };
  }

  const supportedTypes = ['text', 'audio', 'voice', 'interactive', 'location', 'image', 'document', 'sticker'];
  if (!supportedTypes.includes(message.type.toLowerCase())) {
    return { valid: false, reason: `Unsupported message type: ${message.type}` };
  }

  const type = message.type.toLowerCase();
  if (type === 'text') {
    if (!message.text || typeof message.text.body !== 'string') {
      return { valid: false, reason: 'Text message must contain text.body string' };
    }
    if (message.text.body.length > 4096) {
      return { valid: false, reason: 'Text body exceeds maximum length of 4096' };
    }
  } else if (type === 'audio') {
    if (!message.audio || typeof message.audio.id !== 'string') {
      return { valid: false, reason: 'Audio message must contain audio.id string' };
    }
  } else if (type === 'voice') {
    if (!message.voice || typeof message.voice.id !== 'string') {
      return { valid: false, reason: 'Voice message must contain voice.id string' };
    }
  }

  return { valid: true };
};

const validateStatusEntry = (statusEntry) => {
  if (!statusEntry || typeof statusEntry !== 'object') {
    return { valid: false, reason: 'Status entry must be a non-null object' };
  }
  if (typeof statusEntry.id !== 'string' || !statusEntry.id.trim()) {
    return { valid: false, reason: 'Status entry id must be a non-empty string' };
  }
  const validStatuses = ['sent', 'delivered', 'read', 'failed'];
  if (typeof statusEntry.status !== 'string' || !validStatuses.includes(statusEntry.status.toLowerCase())) {
    return { valid: false, reason: `Status must be one of: ${validStatuses.join(', ')}` };
  }
  if (statusEntry.timestamp == null || String(statusEntry.timestamp).trim() === '' || Number.isNaN(Number(statusEntry.timestamp))) {
    return { valid: false, reason: 'Status timestamp must be a valid timestamp' };
  }
  return { valid: true };
};

module.exports = {
  validateWebhookEnvelope,
  validateInboundMessage,
  validateStatusEntry,
};
