'use strict';

/**
 * WhatsApp Cloud API Interactive Message Limits & Specifications
 * Reference: Meta WhatsApp Business Platform Cloud API documentation
 */
const LIMITS = Object.freeze({
  BUTTON_MIN_COUNT: 1,
  BUTTON_MAX_COUNT: 3,
  BUTTON_TITLE_MAX_LENGTH: 20,
  BUTTON_ID_MAX_LENGTH: 256,
  LIST_MIN_TOTAL_ROWS: 1,
  LIST_MAX_TOTAL_ROWS: 10,
  LIST_BUTTON_TITLE_MAX_LENGTH: 20,
  SECTION_TITLE_MAX_LENGTH: 24,
  ROW_TITLE_MAX_LENGTH: 24,
  ROW_ID_MAX_LENGTH: 200,
  ROW_DESCRIPTION_MAX_LENGTH: 72,
  BODY_TEXT_MAX_LENGTH: 1024,
  HEADER_TEXT_MAX_LENGTH: 60,
  FOOTER_TEXT_MAX_LENGTH: 60,
});

/**
 * Sanitize and enforce max string length without throwing
 */
const truncate = (val, maxLen) => {
  if (val === undefined || val === null) return '';
  return String(val).trim().slice(0, maxLen);
};

/**
 * Format optional header (text or media object)
 */
const formatHeader = (header) => {
  if (!header) return null;
  if (typeof header === 'string') {
    const text = truncate(header, LIMITS.HEADER_TEXT_MAX_LENGTH);
    return text ? { type: 'text', text } : null;
  }
  if (typeof header === 'object' && header.type) {
    return header;
  }
  return null;
};

/**
 * Format optional footer (text only)
 */
const formatFooter = (footer) => {
  if (!footer) return null;
  const text = typeof footer === 'string' ? truncate(footer, LIMITS.FOOTER_TEXT_MAX_LENGTH) : truncate(footer.text, LIMITS.FOOTER_TEXT_MAX_LENGTH);
  return text ? { text } : null;
};

/**
 * Builds a WhatsApp Quick Reply button interactive payload.
 *
 * @param {string} bodyText - Main text message body (max 1024 chars).
 * @param {Array<string|{id: string, title: string}>} buttons - 1 to 3 buttons.
 * @param {object} [options]
 * @param {string|object} [options.header] - Optional header (text <= 60 chars or media object).
 * @param {string|object} [options.footer] - Optional footer text (<= 60 chars).
 * @returns {object} WhatsApp interactive button payload.
 */
const buildQuickReplyButtons = (bodyText, buttons, options = {}) => {
  const text = truncate(bodyText, LIMITS.BODY_TEXT_MAX_LENGTH);
  if (!text) {
    throw new Error('Quick reply buttons require a non-empty body text');
  }

  if (!Array.isArray(buttons) || buttons.length < LIMITS.BUTTON_MIN_COUNT || buttons.length > LIMITS.BUTTON_MAX_COUNT) {
    throw new Error(`Quick reply buttons must contain between ${LIMITS.BUTTON_MIN_COUNT} and ${LIMITS.BUTTON_MAX_COUNT} buttons (received ${buttons?.length ?? 0})`);
  }

  const seenIds = new Set();
  const formattedButtons = buttons.map((btn, index) => {
    let id;
    let title;
    if (typeof btn === 'string') {
      id = truncate(btn.toLowerCase().replace(/\s+/g, '_'), LIMITS.BUTTON_ID_MAX_LENGTH) || `btn_${index + 1}`;
      title = truncate(btn, LIMITS.BUTTON_TITLE_MAX_LENGTH);
    } else if (btn && typeof btn === 'object') {
      id = truncate(btn.id, LIMITS.BUTTON_ID_MAX_LENGTH) || `btn_${index + 1}`;
      title = truncate(btn.title, LIMITS.BUTTON_TITLE_MAX_LENGTH);
    } else {
      throw new Error(`Invalid button at index ${index}: must be a string or object with { id, title }`);
    }

    if (!title) {
      throw new Error(`Button at index ${index} must have a non-empty title`);
    }

    if (seenIds.has(id)) {
      throw new Error(`Duplicate button id "${id}" at index ${index}`);
    }
    seenIds.add(id);

    return {
      type: 'reply',
      reply: {
        id,
        title,
      },
    };
  });

  const payload = {
    type: 'button',
    body: { text },
    action: {
      buttons: formattedButtons,
    },
  };

  const header = formatHeader(options.header);
  if (header) payload.header = header;

  const footer = formatFooter(options.footer);
  if (footer) payload.footer = footer;

  return payload;
};

/**
 * Builds standard Quick Reply buttons for Payment Confirmation.
 * e.g. [Confirm Payment] and [Cancel]
 *
 * @param {object} params
 * @param {string|number} params.amount
 * @param {string} params.asset
 * @param {string} params.recipient - Destination or recipient name/label.
 * @param {string} [params.fee] - Optional fee string.
 * @param {string} [params.memo] - Optional memo text.
 * @param {string} [params.confirmId='confirm_payment'] - Callback id for confirm button.
 * @param {string} [params.cancelId='cancel_payment'] - Callback id for cancel button.
 * @param {string} [params.confirmTitle='Confirm Payment'] - Button title (max 20 chars).
 * @param {string} [params.cancelTitle='Cancel'] - Button title (max 20 chars).
 * @param {string} [params.bodyText] - Optional override for message body.
 * @param {string} [params.header] - Optional header text.
 * @param {string} [params.footer] - Optional footer text.
 * @returns {object} WhatsApp interactive button payload.
 */
const buildPaymentConfirmationButtons = ({
  amount,
  asset = 'XLM',
  recipient,
  fee,
  memo,
  confirmId = 'confirm_payment',
  cancelId = 'cancel_payment',
  confirmTitle = 'Confirm Payment',
  cancelTitle = 'Cancel',
  bodyText,
  header,
  footer = 'SendAm Instant Settlement',
} = {}) => {
  let text = bodyText;
  if (!text) {
    const lines = [
      `Please confirm your payment of ${amount} ${asset}`,
      `To: ${recipient}`,
    ];
    if (fee) lines.push(`Network Fee: ${fee} ${asset}`);
    if (memo) lines.push(`Memo: ${memo}`);
    lines.push('Tap Confirm to proceed or Cancel to abort.');
    text = lines.join('\n');
  }

  return buildQuickReplyButtons(
    text,
    [
      { id: confirmId, title: confirmTitle },
      { id: cancelId, title: cancelTitle },
    ],
    { header, footer }
  );
};

/**
 * Builds a WhatsApp List Menu interactive payload.
 *
 * @param {string} bodyText - Main text message body (max 1024 chars).
 * @param {string} buttonText - Action button label that opens the list (max 20 chars).
 * @param {Array<{title?: string, rows: Array<{id: string, title: string, description?: string}>}>} sections
 * @param {object} [options]
 * @param {string|object} [options.header]
 * @param {string|object} [options.footer]
 * @returns {object} WhatsApp interactive list payload.
 */
const buildListMenu = (bodyText, buttonText, sections, options = {}) => {
  const text = truncate(bodyText, LIMITS.BODY_TEXT_MAX_LENGTH);
  if (!text) {
    throw new Error('List menu requires a non-empty body text');
  }

  const btnText = truncate(buttonText, LIMITS.LIST_BUTTON_TITLE_MAX_LENGTH);
  if (!btnText) {
    throw new Error('List menu requires a non-empty button label (max 20 chars)');
  }

  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error('List menu must contain at least one section');
  }

  let totalRows = 0;
  const seenRowIds = new Set();

  const formattedSections = sections.map((sec, secIdx) => {
    if (!sec || typeof sec !== 'object' || !Array.isArray(sec.rows)) {
      throw new Error(`Section at index ${secIdx} must be an object with a rows array`);
    }

    const rows = sec.rows.map((row, rowIdx) => {
      totalRows += 1;
      if (!row || typeof row !== 'object') {
        throw new Error(`Row at section ${secIdx}, index ${rowIdx} must be an object with { id, title }`);
      }

      const id = truncate(row.id, LIMITS.ROW_ID_MAX_LENGTH);
      const title = truncate(row.title, LIMITS.ROW_TITLE_MAX_LENGTH);
      if (!id) throw new Error(`Row at section ${secIdx}, index ${rowIdx} must have a non-empty id`);
      if (!title) throw new Error(`Row at section ${secIdx}, index ${rowIdx} must have a non-empty title`);

      if (seenRowIds.has(id)) {
        throw new Error(`Duplicate row id "${id}" in list menu`);
      }
      seenRowIds.add(id);

      const formattedRow = { id, title };
      if (row.description) {
        const description = truncate(row.description, LIMITS.ROW_DESCRIPTION_MAX_LENGTH);
        if (description) formattedRow.description = description;
      }
      return formattedRow;
    });

    const formattedSection = { rows };
    if (sec.title) {
      const title = truncate(sec.title, LIMITS.SECTION_TITLE_MAX_LENGTH);
      if (title) formattedSection.title = title;
    }
    return formattedSection;
  });

  if (totalRows < LIMITS.LIST_MIN_TOTAL_ROWS || totalRows > LIMITS.LIST_MAX_TOTAL_ROWS) {
    throw new Error(`List menu must contain between ${LIMITS.LIST_MIN_TOTAL_ROWS} and ${LIMITS.LIST_MAX_TOTAL_ROWS} total rows across all sections (received ${totalRows})`);
  }

  const payload = {
    type: 'list',
    body: { text },
    action: {
      button: btnText,
      sections: formattedSections,
    },
  };

  const header = formatHeader(options.header);
  if (header) payload.header = header;

  const footer = formatFooter(options.footer);
  if (footer) payload.footer = footer;

  return payload;
};

/**
 * Builds standard Corridor Selection List Menu.
 * e.g. Nigeria to Ghana, Nigeria to Kenya, etc.
 *
 * @param {object} params
 * @param {Array<string|{id: string, title: string, description?: string}>} params.corridors
 * @param {string} [params.bodyText='Select payment corridor:']
 * @param {string} [params.buttonText='Select Corridor']
 * @param {string} [params.sectionTitle='Available Corridors']
 * @param {string} [params.header]
 * @param {string} [params.footer='SendAm Cross-Border Rails']
 * @returns {object} WhatsApp interactive list payload.
 */
const buildCorridorSelectionMenu = ({
  corridors = [
    { id: 'corridor:NGN:GHS', title: 'Nigeria -> Ghana', description: 'NGN to GHS via Mobile Money' },
    { id: 'corridor:NGN:KES', title: 'Nigeria -> Kenya', description: 'NGN to KES via M-Pesa' },
    { id: 'corridor:NGN:USDC', title: 'Nigeria -> USDC', description: 'NGN to Stellar USDC' },
    { id: 'corridor:USD:NGN', title: 'USA -> Nigeria', description: 'USD to NGN Bank Transfer' },
    { id: 'corridor:GHS:NGN', title: 'Ghana -> Nigeria', description: 'GHS to NGN Instant Bank' },
  ],
  bodyText = 'Select your remittance corridor to view live rates and routes:',
  buttonText = 'Select Corridor',
  sectionTitle = 'Available Corridors',
  header,
  footer = 'SendAm Cross-Border Rails',
} = {}) => {
  const rows = corridors.slice(0, LIMITS.LIST_MAX_TOTAL_ROWS).map((c, i) => {
    if (typeof c === 'string') {
      const normalized = c.trim().toUpperCase();
      return {
        id: `corridor:${normalized}`,
        title: truncate(c, LIMITS.ROW_TITLE_MAX_LENGTH),
        description: `Corridor ${normalized}`,
      };
    }
    return {
      id: c.id || `corridor:${i + 1}`,
      title: c.title,
      description: c.description,
    };
  });

  return buildListMenu(
    bodyText,
    buttonText,
    [{ title: sectionTitle, rows }],
    { header, footer }
  );
};

/**
 * Wraps an interactive payload into the complete Meta Graph API outbound message envelope.
 *
 * @param {string} to - Recipient phone number (e.g. "+2348012345678" or "2348012345678").
 * @param {object} interactivePayload - Payload produced by buildQuickReplyButtons or buildListMenu.
 * @returns {object} Complete WhatsApp outbound message payload.
 */
const buildInteractiveMessage = (to, interactivePayload) => {
  if (!to || typeof to !== 'string') {
    throw new Error('Recipient "to" must be a non-empty phone string');
  }
  if (!interactivePayload || typeof interactivePayload !== 'object' || !['button', 'list'].includes(interactivePayload.type)) {
    throw new Error('Invalid interactive payload: must be an interactive button or list object');
  }

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to.replace(/^\+/, ''),
    type: 'interactive',
    interactive: interactivePayload,
  };
};

/**
 * Parses and extracts callback payload from an inbound WhatsApp message.
 * Supports both button_reply (Quick Reply) and list_reply (List Menu).
 *
 * @param {object} message - Inbound message object from Meta webhook change.
 * @returns {{type: 'button_reply'|'list_reply', id: string, title: string, description?: string, payload: string}|null}
 */
const parseInteractiveInbound = (message) => {
  if (!message || typeof message !== 'object') return null;
  if (message.type !== 'interactive' || !message.interactive || typeof message.interactive !== 'object') {
    return null;
  }

  const { type, button_reply, list_reply } = message.interactive;

  if (type === 'button_reply' && button_reply && typeof button_reply === 'object') {
    const id = String(button_reply.id || '');
    const title = String(button_reply.title || '');
    return {
      type: 'button_reply',
      id,
      title,
      payload: id,
    };
  }

  if (type === 'list_reply' && list_reply && typeof list_reply === 'object') {
    const id = String(list_reply.id || '');
    const title = String(list_reply.title || '');
    const description = list_reply.description ? String(list_reply.description) : null;
    return {
      type: 'list_reply',
      id,
      title,
      description,
      payload: id,
    };
  }

  return null;
};

module.exports = {
  LIMITS,
  buildQuickReplyButtons,
  buildPaymentConfirmationButtons,
  buildListMenu,
  buildCorridorSelectionMenu,
  buildInteractiveMessage,
  parseInteractiveInbound,
};
