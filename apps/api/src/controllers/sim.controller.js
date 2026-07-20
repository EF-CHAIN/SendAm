const { isValidPhoneNumber } = require('../utils/validators');
const { sendError } = require('../utils/response');

const serializeMessage = (message) => ({
  direction: message.direction,
  text: message.text,
  createdAt: message.createdAt.toISOString(),
});

// `processMessage` defaults to the real assistant pipeline, lazily required
// so tests can inject a fake pipeline without pulling in assistant.service.js
// (and, transitively, the Prisma client) at all.
//
// The conversation store is an interim in-memory Map. It stands in for the
// SimMessage table + simMessage.service.js (see issue #9, not merged yet) so
// these endpoints (#10) can ship independently. It resets on process restart
// and isn't shared across instances — swap for the real store once #9 lands.
const createSimController = ({ processMessage } = {}) => {
  const pipeline = processMessage || require('../whatsapp/assistant.service').processMessage;
  const conversations = new Map();

  const appendMessage = (phoneNumber, direction, text) => {
    const message = { direction, text, createdAt: new Date() };
    const history = conversations.get(phoneNumber) || [];
    history.push(message);
    conversations.set(phoneNumber, history);
    return message;
  };

  // POST /api/sim/message — runs the real assistant pipeline (the same
  // processMessage the WhatsApp webhook uses) and returns its replies
  // inline, instead of sending them out through Meta.
  const handleMessage = async (req, res, next) => {
    try {
      const { phoneNumber, name, text } = req.body || {};
      if (!isValidPhoneNumber(phoneNumber)) {
        return sendError(res, 'A valid phoneNumber is required');
      }
      if (typeof text !== 'string' || !text.trim()) {
        return sendError(res, 'text is required');
      }

      appendMessage(phoneNumber, 'in', text);

      const replies = [];
      await pipeline(phoneNumber, name, text, {
        notify: async (_phoneNumber, replyText) => {
          replies.push(replyText);
          appendMessage(phoneNumber, 'out', replyText);
        },
      });

      return res.status(200).json({ replies });
    } catch (error) {
      next(error);
    }
  };

  // GET /api/sim/messages/:phone?since=<ISO date> — the ordered conversation
  // for that phone, optionally narrowed to messages newer than `since`.
  const listMessages = (req, res) => {
    const { phone } = req.params;
    if (!isValidPhoneNumber(phone)) {
      return sendError(res, 'A valid phone number is required');
    }

    let history = conversations.get(phone) || [];

    const { since } = req.query;
    if (since !== undefined) {
      const sinceDate = new Date(since);
      if (Number.isNaN(sinceDate.getTime())) {
        return sendError(res, 'since must be a valid ISO date');
      }
      history = history.filter((message) => message.createdAt > sinceDate);
    }

    return res.status(200).json({ messages: history.map(serializeMessage) });
  };

  return { handleMessage, listMessages };
};

module.exports = createSimController;
