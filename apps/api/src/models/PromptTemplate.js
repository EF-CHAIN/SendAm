const mongoose = require('mongoose');

// The AI intent decoder's system prompt lives here, not in the codebase.
// The prompt itself is tuned, versioned content — it's fetched at request
// time rather than committed, so a forked repo gets the calling code but
// not the tuned prompt (see ARCHITECTURE.md).
const promptTemplateSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
  },
  version: {
    type: Number,
    default: 1,
  },
  content: {
    type: String,
    required: true,
  },
}, { timestamps: true });

module.exports = mongoose.model('PromptTemplate', promptTemplateSchema);
