'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  LIMITS,
  buildQuickReplyButtons,
  buildPaymentConfirmationButtons,
  buildListMenu,
  buildCorridorSelectionMenu,
  buildInteractiveMessage,
  parseInteractiveInbound,
} = require('../src/whatsapp/interactivePayloads');

const {
  validateInboundMessage,
} = require('../src/whatsapp/webhook.validator');

describe('whatsapp/interactivePayloads', () => {
  describe('buildQuickReplyButtons', () => {
    it('builds a valid quick reply button payload with 2 buttons', () => {
      const payload = buildQuickReplyButtons('Do you want to proceed?', [
        { id: 'btn_yes', title: 'Yes' },
        { id: 'btn_no', title: 'No' },
      ]);

      assert.equal(payload.type, 'button');
      assert.equal(payload.body.text, 'Do you want to proceed?');
      assert.equal(payload.action.buttons.length, 2);
      assert.deepEqual(payload.action.buttons[0], {
        type: 'reply',
        reply: { id: 'btn_yes', title: 'Yes' },
      });
      assert.deepEqual(payload.action.buttons[1], {
        type: 'reply',
        reply: { id: 'btn_no', title: 'No' },
      });
    });

    it('supports string buttons and header/footer options', () => {
      const payload = buildQuickReplyButtons(
        'Choose an option',
        ['Accept', 'Decline'],
        { header: 'Terms Update', footer: 'Powered by SendAm' }
      );

      assert.equal(payload.header.type, 'text');
      assert.equal(payload.header.text, 'Terms Update');
      assert.equal(payload.footer.text, 'Powered by SendAm');
      assert.equal(payload.action.buttons[0].reply.id, 'accept');
      assert.equal(payload.action.buttons[0].reply.title, 'Accept');
    });

    it('truncates button title to 20 chars per Meta limit', () => {
      const payload = buildQuickReplyButtons('Prompt', [
        { id: 'long_title_btn', title: 'This Title Is Way Too Long For Meta' },
      ]);
      assert.ok(payload.action.buttons[0].reply.title.length <= LIMITS.BUTTON_TITLE_MAX_LENGTH);
      assert.equal(payload.action.buttons[0].reply.title, 'This Title Is Way To');
    });

    it('rejects empty body text', () => {
      assert.throws(() => {
        buildQuickReplyButtons('', [{ id: '1', title: 'OK' }]);
      }, /non-empty body text/);
    });

    it('rejects button lists with less than 1 or more than 3 buttons', () => {
      assert.throws(() => {
        buildQuickReplyButtons('Prompt', []);
      }, /between 1 and 3 buttons/);

      assert.throws(() => {
        buildQuickReplyButtons('Prompt', [
          { id: '1', title: 'One' },
          { id: '2', title: 'Two' },
          { id: '3', title: 'Three' },
          { id: '4', title: 'Four' },
        ]);
      }, /between 1 and 3 buttons/);
    });

    it('rejects duplicate button IDs', () => {
      assert.throws(() => {
        buildQuickReplyButtons('Prompt', [
          { id: 'dup', title: 'First' },
          { id: 'dup', title: 'Second' },
        ]);
      }, /Duplicate button id/);
    });
  });

  describe('buildPaymentConfirmationButtons', () => {
    it('builds standard [Confirm Payment] and [Cancel] buttons', () => {
      const payload = buildPaymentConfirmationButtons({
        amount: '100',
        asset: 'USDC',
        recipient: 'Alice (GA123...)',
        fee: '0.01',
      });

      assert.equal(payload.type, 'button');
      assert.ok(payload.body.text.includes('100 USDC'));
      assert.ok(payload.body.text.includes('Alice (GA123...)'));
      assert.ok(payload.body.text.includes('0.01 USDC'));
      assert.equal(payload.action.buttons.length, 2);
      assert.equal(payload.action.buttons[0].reply.id, 'confirm_payment');
      assert.equal(payload.action.buttons[0].reply.title, 'Confirm Payment');
      assert.equal(payload.action.buttons[1].reply.id, 'cancel_payment');
      assert.equal(payload.action.buttons[1].reply.title, 'Cancel');
    });

    it('allows custom IDs, titles, and bodyText override', () => {
      const payload = buildPaymentConfirmationButtons({
        bodyText: 'Custom confirmation prompt',
        confirmId: 'yes',
        cancelId: 'no',
        confirmTitle: 'Yes, Send',
        cancelTitle: 'Abort',
      });

      assert.equal(payload.body.text, 'Custom confirmation prompt');
      assert.equal(payload.action.buttons[0].reply.id, 'yes');
      assert.equal(payload.action.buttons[0].reply.title, 'Yes, Send');
      assert.equal(payload.action.buttons[1].reply.id, 'no');
      assert.equal(payload.action.buttons[1].reply.title, 'Abort');
    });
  });

  describe('buildListMenu', () => {
    it('builds a valid list menu payload', () => {
      const payload = buildListMenu(
        'Please select a service:',
        'View Services',
        [
          {
            title: 'Transfers',
            rows: [
              { id: 'srv_send', title: 'Send Money', description: 'Instant transfer' },
              { id: 'srv_receive', title: 'Receive Money', description: 'Show deposit address' },
            ],
          },
        ],
        { footer: 'SendAm Banking' }
      );

      assert.equal(payload.type, 'list');
      assert.equal(payload.body.text, 'Please select a service:');
      assert.equal(payload.action.button, 'View Services');
      assert.equal(payload.action.sections.length, 1);
      assert.equal(payload.action.sections[0].title, 'Transfers');
      assert.equal(payload.action.sections[0].rows.length, 2);
      assert.equal(payload.action.sections[0].rows[0].id, 'srv_send');
      assert.equal(payload.footer.text, 'SendAm Banking');
    });

    it('enforces row length limits (title <= 24, description <= 72)', () => {
      const payload = buildListMenu('Select', 'Open Menu', [
        {
          title: 'Section 1',
          rows: [
            {
              id: 'row_1',
              title: 'Super Long Title Beyond Twenty Four Chars',
              description: 'A'.repeat(100),
            },
          ],
        },
      ]);

      const row = payload.action.sections[0].rows[0];
      assert.ok(row.title.length <= LIMITS.ROW_TITLE_MAX_LENGTH);
      assert.ok(row.description.length <= LIMITS.ROW_DESCRIPTION_MAX_LENGTH);
    });

    it('rejects lists with more than 10 total rows', () => {
      const rows = Array.from({ length: 11 }, (_, i) => ({ id: `r_${i}`, title: `Row ${i}` }));
      assert.throws(() => {
        buildListMenu('Body', 'Open', [{ title: 'Sec', rows }]);
      }, /between 1 and 10 total rows/);
    });

    it('rejects duplicate row IDs across sections', () => {
      assert.throws(() => {
        buildListMenu('Body', 'Open', [
          { title: 'Sec 1', rows: [{ id: 'dup_row', title: 'R1' }] },
          { title: 'Sec 2', rows: [{ id: 'dup_row', title: 'R2' }] },
        ]);
      }, /Duplicate row id/);
    });
  });

  describe('buildCorridorSelectionMenu', () => {
    it('builds corridor selection menu with default corridors', () => {
      const payload = buildCorridorSelectionMenu();

      assert.equal(payload.type, 'list');
      assert.equal(payload.action.button, 'Select Corridor');
      assert.ok(payload.action.sections[0].rows.length >= 3);
      assert.equal(payload.action.sections[0].rows[0].id, 'corridor:NGN:GHS');
      assert.equal(payload.action.sections[0].rows[0].title, 'Nigeria -> Ghana');
    });

    it('supports custom corridor list', () => {
      const payload = buildCorridorSelectionMenu({
        corridors: [
          { id: 'corridor:NG-GH', title: 'NG to GH', description: 'Nigeria to Ghana' },
          { id: 'corridor:NG-KE', title: 'NG to KE', description: 'Nigeria to Kenya' },
        ],
        buttonText: 'Choose Corridor',
      });

      assert.equal(payload.action.button, 'Choose Corridor');
      assert.equal(payload.action.sections[0].rows.length, 2);
      assert.equal(payload.action.sections[0].rows[0].id, 'corridor:NG-GH');
      assert.equal(payload.action.sections[0].rows[1].id, 'corridor:NG-KE');
    });
  });

  describe('buildInteractiveMessage', () => {
    it('wraps interactive payload into complete Meta message envelope', () => {
      const interactive = buildQuickReplyButtons('Confirm?', [
        { id: 'confirm', title: 'Confirm' },
        { id: 'cancel', title: 'Cancel' },
      ]);
      const message = buildInteractiveMessage('+2348012345678', interactive);

      assert.equal(message.messaging_product, 'whatsapp');
      assert.equal(message.recipient_type, 'individual');
      assert.equal(message.to, '2348012345678');
      assert.equal(message.type, 'interactive');
      assert.deepEqual(message.interactive, interactive);
    });

    it('rejects invalid recipient or payload', () => {
      assert.throws(() => {
        buildInteractiveMessage('', {});
      }, /Recipient "to" must be a non-empty phone string/);

      assert.throws(() => {
        buildInteractiveMessage('2348012345678', { type: 'invalid' });
      }, /Invalid interactive payload/);
    });
  });

  describe('parseInteractiveInbound', () => {
    it('parses button_reply callback correctly', () => {
      const inboundMsg = {
        from: '2348012345678',
        id: 'wamid.123',
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: {
            id: 'confirm_payment',
            title: 'Confirm Payment',
          },
        },
      };

      const parsed = parseInteractiveInbound(inboundMsg);
      assert.deepEqual(parsed, {
        type: 'button_reply',
        id: 'confirm_payment',
        title: 'Confirm Payment',
        payload: 'confirm_payment',
      });
    });

    it('parses list_reply callback correctly', () => {
      const inboundMsg = {
        from: '2348012345678',
        id: 'wamid.456',
        type: 'interactive',
        interactive: {
          type: 'list_reply',
          list_reply: {
            id: 'corridor:NG-GH',
            title: 'Nigeria to Ghana',
            description: 'NGN to GHS',
          },
        },
      };

      const parsed = parseInteractiveInbound(inboundMsg);
      assert.deepEqual(parsed, {
        type: 'list_reply',
        id: 'corridor:NG-GH',
        title: 'Nigeria to Ghana',
        description: 'NGN to GHS',
        payload: 'corridor:NG-GH',
      });
    });

    it('returns null for non-interactive messages or missing fields', () => {
      assert.equal(parseInteractiveInbound(null), null);
      assert.equal(parseInteractiveInbound({ type: 'text', text: { body: 'hi' } }), null);
      assert.equal(parseInteractiveInbound({ type: 'interactive' }), null);
      assert.equal(parseInteractiveInbound({ type: 'interactive', interactive: {} }), null);
    });
  });

  describe('webhook.validator with interactive messages', () => {
    it('validates a valid button_reply message', () => {
      const validMsg = {
        id: 'wamid.btn_test',
        from: '2348012345678',
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: {
            id: 'btn_1',
            title: 'Option 1',
          },
        },
      };

      const result = validateInboundMessage(validMsg);
      assert.deepEqual(result, { valid: true });
    });

    it('validates a valid list_reply message', () => {
      const validMsg = {
        id: 'wamid.list_test',
        from: '2348012345678',
        type: 'interactive',
        interactive: {
          type: 'list_reply',
          list_reply: {
            id: 'corridor:NG-GH',
            title: 'Nigeria to Ghana',
          },
        },
      };

      const result = validateInboundMessage(validMsg);
      assert.deepEqual(result, { valid: true });
    });

    it('rejects malformed interactive messages', () => {
      const missingInteractive = {
        id: 'wamid.bad',
        from: '2348012345678',
        type: 'interactive',
      };
      assert.equal(validateInboundMessage(missingInteractive).valid, false);

      const invalidType = {
        id: 'wamid.bad',
        from: '2348012345678',
        type: 'interactive',
        interactive: { type: 'unknown_type' },
      };
      assert.equal(validateInboundMessage(invalidType).valid, false);

      const missingButtonId = {
        id: 'wamid.bad',
        from: '2348012345678',
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: {},
        },
      };
      assert.equal(validateInboundMessage(missingButtonId).valid, false);
    });
  });
});
