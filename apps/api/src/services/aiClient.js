// Thin client for the privately-operated sendam-ai intent decoder. The regex
// parser in whatsapp/assistant.service.js stays PRIMARY — this client is
// only consulted when the regex can't classify a message, and only when
// explicitly enabled. The decoder proposes; the same confirmation flow, PIN
// check, and policy guardrails execute. Anything unusable (UNKNOWN, non-SEND,
// missing fields, service off/unreachable) degrades to null, which reads as
// "couldn't parse that" — never a broken bot.
const config = require('../config/env');
const defaultLogger = require('../utils/logger');
const { createServiceClient } = require('./serviceClient');

const createAiClient = ({ aiConfig = config.ai, fetchImpl, logger = defaultLogger } = {}) => {
  const client = createServiceClient({
    name: 'ai',
    baseUrl: aiConfig.serviceUrl,
    secret: aiConfig.secret,
    fetchImpl,
    logger,
  });

  const enabled = Boolean(aiConfig.enabled && client.enabled);
  if (aiConfig.enabled && !client.enabled) {
    logger.warn('ENABLE_AI_INTENT is true but AI_SERVICE_URL/AI_SERVICE_SECRET are unset — AI intent decoding disabled');
  }

  /**
   * Decode free text into the regex parser's payment-intent shape
   * ({amount, asset, recipient}) or null. userId is the opaque user id —
   * phone numbers must never be sent to the AI service.
   */
  const decodeToPaymentIntent = async (text, userId) => {
    if (!enabled) return null;
    const result = await client.post('/decode', { text, userId });
    if (!result.ok) return null;

    const intent = result.data;
    if (!intent || intent.intent !== 'SEND' || !intent.amount || !intent.recipient) return null;
    return {
      amount: String(intent.amount),
      // Mirror parsePaymentIntent: no asset stated → undefined, so the
      // payment orchestrator defaults to the destination chain's native asset.
      asset: intent.asset ? String(intent.asset).toUpperCase() : undefined,
      recipient: String(intent.recipient),
    };
  };

  return { enabled, decodeToPaymentIntent };
};

module.exports = {
  createAiClient,
  aiClient: createAiClient(),
};
