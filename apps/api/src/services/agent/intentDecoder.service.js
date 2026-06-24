// Open, generic call + structured-output parse. The tuned system prompt
// that actually makes this useful lives in Mongo (PromptTemplate), not here
// — see ARCHITECTURE.md. This module never decides anything about money; it
// only ever proposes a parsed intent, which the handler re-runs through the
// exact same guardrails a typed command would hit.
const Anthropic = require('@anthropic-ai/sdk');
const PromptTemplate = require('../../models/PromptTemplate');
const config = require('../../config/env');
const logger = require('../../utils/logger');

const PROMPT_KEY = 'intent-decoder-v1';

let client;
const getClient = () => {
  if (!client) {
    client = new Anthropic({ apiKey: config.ai.apiKey });
  }
  return client;
};

// All properties are required (with null allowed via a type union) rather
// than optional — Claude's structured-output mode expects every declared
// property present on every response.
// SAVE_CONTACT is deliberately not offered here — mapping a decoded alias +
// address pair reliably would need dedicated schema fields, and guessing
// wrong on a saved contact is worse than just staying UNKNOWN and asking
// the user to use the exact `save <name> <address>` command.
const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: ['SEND', 'BALANCE', 'CREATE_WALLET', 'LIST_CONTACTS', 'HELP', 'UNKNOWN'],
    },
    chain: { type: ['string', 'null'], enum: ['stellar', 'lisk', null] },
    amount: { type: ['string', 'null'] },
    asset: { type: ['string', 'null'] },
    recipient: { type: ['string', 'null'] },
    confidence: { type: 'number', description: '0 to 1 — how confident the classification is' },
  },
  required: ['intent', 'chain', 'amount', 'asset', 'recipient', 'confidence'],
  additionalProperties: false,
};

// Below this, the decoder's own guess isn't trusted — the caller should stay
// UNKNOWN rather than act on a low-confidence guess.
const CONFIDENCE_THRESHOLD = 0.6;

const getPromptContent = async () => {
  const template = await PromptTemplate.findOne({ key: PROMPT_KEY }).sort({ version: -1 });
  if (!template) {
    throw new Error(`No PromptTemplate seeded for "${PROMPT_KEY}" — run scripts/seed-prompt-template.js`);
  }
  return template.content;
};

// Pure, independently-testable — the network call around it isn't.
const isConfident = (parsed) => Boolean(parsed) && typeof parsed.confidence === 'number' && parsed.confidence >= CONFIDENCE_THRESHOLD;

/**
 * Classify a WhatsApp message into a structured intent. Returns null (never
 * throws to the caller) if the decoder is unavailable, fails, or isn't
 * confident — an AI outage must degrade to "couldn't parse that", never
 * break the bot, and a low-confidence guess is treated the same as no guess.
 */
const decodeIntent = async (text) => {
  try {
    const system = await getPromptContent();

    const response = await getClient().messages.parse({
      model: config.ai.model,
      max_tokens: 512,
      system,
      messages: [{ role: 'user', content: text }],
      output_config: { format: { type: 'json_schema', schema: INTENT_SCHEMA } },
    });

    const parsed = response.parsed_output;
    return isConfident(parsed) ? parsed : null;
  } catch (error) {
    logger.error('Intent decoder failed; falling back to UNKNOWN', error.message);
    return null;
  }
};

module.exports = {
  decodeIntent,
  isConfident,
  CONFIDENCE_THRESHOLD,
  INTENT_SCHEMA,
};
