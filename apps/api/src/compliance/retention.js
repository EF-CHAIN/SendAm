// Customer data inventory, retention rules, and legal-hold policy.
//
// This module is the single source of truth for WHAT personal data we hold,
// WHERE it lives, HOW long it may be kept, and WHICH fields must survive an
// erasure request so we keep financial, AML, audit, and custody records
// intact (NDPA/NDPR + corridor obligations). It is intentionally pure data +
// helpers so it can be unit-tested and reused by the privacy service, the
// API docs, and the legal review pack.

// Classification of the personal data we store, by model + field.
//   pii           — directly identifies a customer (phone, name, document no.)
//   identifier     — links a customer to an external/ledger identity
//   financial     — monetary/ledger data that must be retained for AML
//   communications— message content, transcripts, media
//   audit         — integrity/audit trail, never contains raw secrets
//   derived       — computed risk/score signals
const DATA_INVENTORY = [
  { model: 'User', field: 'phoneNumber', classification: 'pii', notes: 'Primary customer identifier; erased (anonymized) on erasure.' },
  { model: 'User', field: 'whatsappName', classification: 'pii', notes: 'Display name; erased on erasure.' },
  { model: 'User', field: 'pinHash', classification: 'secret', notes: 'Never exported; cleared on erasure.' },
  { model: 'User', field: 'kycTier', classification: 'derived', notes: 'Retained for AML/limits after erasure.' },
  { model: 'User', field: 'riskScore', classification: 'derived', notes: 'Retained for AML after erasure.' },

  { model: 'Wallet', field: 'phoneNumber', classification: 'pii', notes: 'Redacted on erasure.' },
  { model: 'Wallet', field: 'publicKey', classification: 'identifier', notes: 'Ledger identity; retained.' },
  { model: 'Wallet', field: 'encryptedSecretKey', classification: 'secret', notes: 'Custody secret; nulled on erasure, public key retained.' },

  { model: 'Transaction', field: 'userId', classification: 'identifier', notes: 'Ledger link; retained (anonymized user).' },
  { model: 'Transaction', field: 'amount/asset', classification: 'financial', notes: 'Retained for AML; never erased.' },
  { model: 'Transaction', field: 'destination/recipientPhoneNumber', classification: 'pii', notes: 'Counterparty PII; redacted on erasure.' },
  { model: 'Transaction', field: 'txHash/providerTransactionId', classification: 'identifier', notes: 'Settlement proof; retained.' },

  { model: 'KycProfile', field: 'providerReference', classification: 'identifier', notes: 'KYC job id; retained as proof of verification.' },
  { model: 'KycProfile', field: 'metadata', classification: 'pii', notes: 'Applicant PII; redacted on erasure, verification proof retained.' },
  { model: 'KycProfile', field: 'status/tier', classification: 'derived', notes: 'Retained for AML after erasure (set to "erased").' },

  { model: 'VoiceCommand', field: 'transcript', classification: 'communications', notes: 'Erasable on erasure.' },
  { model: 'VoiceCommand', field: 'phoneNumber', classification: 'pii', notes: 'Redacted on erasure.' },

  { model: 'Contact', field: 'phoneNumber/displayName', classification: 'pii', notes: 'Erasable on erasure.' },
  { model: 'Alias', field: 'alias/target', classification: 'pii', notes: 'Erasable on erasure (rows deleted).' },
  { model: 'Notification', field: 'recipient/body', classification: 'communications', notes: 'Redacted on erasure.' },

  { model: 'AuditLog', field: 'action/entityId/metadata', classification: 'audit', notes: 'Retained; must never contain raw PII (redacted on write).' },
];

// Per-model retention decision used by the erasure workflow.
//   erased       — data is anonymized/removed on a fulfilled erasure request
//   redacted     — identity fields cleared but the record is kept (ledger/audit)
//   retained     — record is kept untouched (financial/AML/audit integrity)
const RETENTION_MATRIX = {
  User: { policy: 'erased', notes: 'Anonymized in place; id/derived scores kept for AML.' },
  Wallet: { policy: 'redacted', notes: 'Secret key nulled; public key + balances kept for custody.' },
  Transaction: { policy: 'retained', notes: 'Full ledger retained; counterparty PII redacted.' },
  KycProfile: { policy: 'redacted', notes: 'Applicant PII redacted; verification proof kept for AML (5y).' },
  VoiceCommand: { policy: 'erased', notes: 'Transcript + phone redacted.' },
  Contact: { policy: 'erased', notes: 'Rows anonymized.' },
  Alias: { policy: 'erased', notes: 'Mapping rows deleted.' },
  Notification: { policy: 'redacted', notes: 'Recipient + body redacted.' },
  Quote: { policy: 'redacted', notes: 'Counterparty PII redacted.' },
  RestSession: { policy: 'redacted', notes: 'Session tokens revoked/redacted.' },
  AuditLog: { policy: 'retained', notes: 'Never erased; already redacted on write.' },
  KycWebhookEvent: { policy: 'retained', notes: 'Idempotency/audit trail; no raw PII.' },
  WhatsappStatusEvent: { policy: 'retained', notes: 'Delivery audit; no raw PII.' },
};

// Fields cleared (set to null / empty) when a model is anonymized. Secrets and
// PII are removed; ledger/identifier/derived fields that must survive are left.
const ANONYMIZATION_FIELDS = {
  User: { phoneNumber: null, whatsappName: null, pinHash: null },
  Wallet: { phoneNumber: null, encryptedSecretKey: null },
  KycProfile: {
    // Keep providerReference + status='erased' for AML proof; drop applicant PII.
    country: null,
    metadata: { erasedAt: new Date().toISOString(), reason: 'gdpr_ndpa_erasure' },
    status: 'erased',
  },
  VoiceCommand: { transcript: null, phoneNumber: null, error: null },
  Contact: { phoneNumber: null, displayName: null },
  Notification: { recipient: null, body: '[redacted]' },
  Quote: { metadata: { redacted: true } },
  RestSession: { tokenHash: 'redacted' },
};

// Fields that must NEVER appear in an export or an audit log.
const SECRET_FIELDS = ['pinHash', 'encryptedSecretKey', 'passwordHash', 'tokenHash'];

// A legal hold suspends erasure for a user. Holds are indefinite unless an
// explicit expiry is set. While active, any erasure request is denied and no
// provider propagation runs.
const LEGAL_HOLD_POLICY = {
  suspendsErasure: true,
  indefiniteByDefault: true,
  minReasonLength: 4,
};

// Nigeria NDPA (2023) / NDPR assumptions for legal review. These are product
// assumptions, not legal advice, and are surfaced in SECURITY.md.
const NDPA_ASSUMPTIONS = [
  'NDPA 2023 recognises a right to erasure except where retention is required by law (tax, AML/CFT, accounting).',
  'CBN/AML regulations require retaining transaction and KYC verification records for at least 5 years after the relationship ends.',
  'Erasure is therefore implemented as anonymization: identity PII is removed while ledger, settlement, and verification-proof records are retained.',
  'Cross-border corridors (e.g. NG <-> GH/KE) may impose longer local retention; legal holds are used to extend retention per corridor.',
  'Data exports are portable JSON containing only the customer’s own eligible records, excluding secrets and other customers’ data.',
  'Audit logs record the fact and outcome of privacy requests with redacted metadata only (no PII copied into the audit trail).',
];

const isSecretField = (field) => SECRET_FIELDS.includes(field);
const isErasableModel = (model) => Object.prototype.hasOwnProperty.call(RETENTION_MATRIX, model);
const retentionPolicyFor = (model) => RETENTION_MATRIX[model] || { policy: 'retained', notes: 'Default retain.' };

module.exports = {
  DATA_INVENTORY,
  RETENTION_MATRIX,
  ANONYMIZATION_FIELDS,
  SECRET_FIELDS,
  LEGAL_HOLD_POLICY,
  NDPA_ASSUMPTIONS,
  isSecretField,
  isErasableModel,
  retentionPolicyFor,
};
