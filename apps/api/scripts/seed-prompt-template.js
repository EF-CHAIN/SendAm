// Local/private script. Run manually against your own database with your
// own prompt content — this is NOT run in CI and the content below is a
// PLACEHOLDER good enough for dev/testing, not a tuned production prompt.
// The real prompt is operational content, not code — see ARCHITECTURE.md.
//
// Usage: node scripts/seed-prompt-template.js
const mongoose = require('mongoose');
const config = require('../src/config/env');
const PromptTemplate = require('../src/models/PromptTemplate');

const PROMPT_KEY = 'intent-decoder-v1';

// PLACEHOLDER — replace before relying on this for anything beyond local
// dev/testing. Keep the schema/field names in sync with INTENT_SCHEMA in
// src/services/agent/intentDecoder.service.js if you change them.
const PLACEHOLDER_PROMPT = `You are a WhatsApp payment intent classifier for SendAm, a Stellar and Lisk payments bot.

Given a user's message, classify it into exactly one of: SEND, BALANCE, CREATE_WALLET, LIST_CONTACTS, HELP, UNKNOWN.

Do not attempt to classify "save a contact" requests — always use UNKNOWN for those so the user is guided to the exact 'save <name> <address>' command.

Rules:
- Only classify as SEND if there is a clear amount and a recipient (an address, or a name that could be a saved contact alias).
- "chain" should be "stellar" or "lisk" only if the message clearly implies one (e.g. mentions "xlm"/"stellar" or "eth"/"lisk", or the recipient looks like a 0x address). Otherwise use null and let the destination address decide.
- If you are not confident, set intent to UNKNOWN and confidence low — do not guess.
- Never infer an amount or recipient that was not stated or clearly implied.
- confidence is a number from 0 to 1 reflecting how sure you are of this classification.`;

const seed = async () => {
  await mongoose.connect(config.mongoUri);

  await PromptTemplate.findOneAndUpdate(
    { key: PROMPT_KEY },
    { key: PROMPT_KEY, content: PLACEHOLDER_PROMPT },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log(`Seeded placeholder prompt for "${PROMPT_KEY}". Replace PLACEHOLDER_PROMPT with tuned content before production use.`);
  await mongoose.disconnect();
};

seed().catch((error) => {
  console.error('Failed to seed prompt template:', error.message);
  process.exit(1);
});
