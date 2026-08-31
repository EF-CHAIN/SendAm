'use strict';

// Time-based retention windows and the rules the purge sweep obeys (#315).
//
// `retention.js` already describes what happens to a customer's data when
// *they* ask for erasure. This is the other half: how long operational data is
// kept when nobody asks. Without it, message bodies, webhook payloads, session
// rows and delivery receipts accumulate indefinitely, which is both a privacy
// liability and a growing blast radius for any future breach.
//
// Every window is overridable by environment variable so a corridor with
// longer local obligations can extend one without a code change.

const envDays = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  // A malformed override falls back to the default rather than to zero.
  // Reading "" or "abc" as 0 would turn a policy into "purge everything now",
  // which is the one mistake here that cannot be undone.
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
};

/**
 * How each purgeable model is treated.
 *
 *   action: 'delete'  — the row is removed outright
 *   action: 'redact'  — the row survives with its personal fields cleared,
 *                       because something downstream still needs the shape of
 *                       the record (delivery stats, dispute history)
 *
 * `guard` names the invariant the sweep must not violate. These are the reason
 * the sweep is safe to run unattended: nothing financial, nothing in dispute,
 * and nothing under legal hold is ever touched.
 */
const RETENTION_POLICIES = {
  Notification: {
    retentionDays: envDays('RETENTION_NOTIFICATION_DAYS', 180),
    action: 'redact',
    timestampField: 'createdAt',
    redactFields: { recipient: null, body: '[purged]' },
    guard: 'terminal_status_only',
    notes: 'Message bodies are the highest-volume PII we hold; delivery counts are kept.',
  },
  WhatsappStatusEvent: {
    retentionDays: envDays('RETENTION_STATUS_EVENT_DAYS', 90),
    action: 'delete',
    timestampField: 'receivedAt',
    guard: 'none',
    notes: 'Delivery receipts; superseded once the Notification reaches a terminal state.',
  },
  WebhookEvent: {
    retentionDays: envDays('RETENTION_WEBHOOK_EVENT_DAYS', 90),
    action: 'delete',
    timestampField: 'createdAt',
    guard: 'completed_only',
    notes: 'Replay-protection ledger (#311); a still-processing row must survive.',
  },
  ProcessedMessage: {
    retentionDays: envDays('RETENTION_PROCESSED_MESSAGE_DAYS', 90),
    action: 'delete',
    timestampField: 'createdAt',
    guard: 'completed_only',
    notes: 'Inbound dedup claims; a claiming/failed row is still live.',
  },
  VoiceCommand: {
    retentionDays: envDays('RETENTION_VOICE_COMMAND_DAYS', 90),
    action: 'redact',
    timestampField: 'createdAt',
    redactFields: { transcript: null, phoneNumber: null },
    guard: 'none',
    notes: 'Transcripts are speech content; the command outcome is kept.',
  },
  RestSession: {
    retentionDays: envDays('RETENTION_REST_SESSION_DAYS', 30),
    action: 'delete',
    timestampField: 'createdAt',
    guard: 'expired_only',
    notes: 'Expired sessions have no further use; an active one must survive.',
  },
  SimMessage: {
    retentionDays: envDays('RETENTION_SIM_MESSAGE_DAYS', 14),
    action: 'delete',
    timestampField: 'createdAt',
    guard: 'none',
    notes: 'Chat-simulator traffic; never production customer data.',
  },
  RateLimitHit: {
    retentionDays: envDays('RETENTION_RATE_LIMIT_HIT_DAYS', 7),
    action: 'delete',
    timestampField: 'createdAt',
    guard: 'none',
    notes: 'Throttling counters; only useful while the window is open.',
  },
};

/**
 * Models that are never purged on a timer, and why.
 *
 * Listed explicitly rather than omitted, so that adding a model to the sweep is
 * a decision someone makes on purpose and a reviewer can see what was
 * considered. A financial or audit record leaving on a schedule is the failure
 * mode this whole module exists to avoid.
 */
const NEVER_PURGED = {
  Transaction: 'Ledger record; AML retention (5y) and dispute evidence.',
  JournalEntry: 'Double-entry ledger; must reconcile for the life of the account.',
  LedgerPosting: 'Double-entry ledger.',
  Wallet: 'Custody record; deleting it orphans on-chain funds.',
  AuditLog: 'Integrity chain; a gap makes the whole chain unverifiable.',
  KycProfile: 'Verification proof; AML retention.',
  SanctionsScreeningResult: 'Screening evidence; AML retention.',
  User: 'Erasure is a customer-initiated workflow, never a timer.',
  LegalHold: 'The thing that suspends purging cannot itself be purged.',
  PrivacyRequest: 'Proof that a privacy request was handled.',
};

const PURGEABLE_MODELS = Object.keys(RETENTION_POLICIES);

const policyFor = (model) => RETENTION_POLICIES[model] || null;
const isPurgeable = (model) => Object.prototype.hasOwnProperty.call(RETENTION_POLICIES, model);
const isNeverPurged = (model) => Object.prototype.hasOwnProperty.call(NEVER_PURGED, model);

/** The oldest timestamp a record may have and still be kept. */
const cutoffFor = (model, now = new Date()) => {
  const policy = policyFor(model);
  if (!policy) return null;
  return new Date(now.getTime() - policy.retentionDays * 24 * 60 * 60 * 1000);
};

/**
 * Extra `where` clauses that keep the sweep off live state.
 *
 * A retention window says a record is old enough to go; a guard says it is
 * actually finished with. Both must hold — age alone would delete a webhook
 * still mid-retry, or a session someone is using right now.
 */
const guardClauseFor = (model, now = new Date()) => {
  const policy = policyFor(model);
  if (!policy) return {};

  switch (policy.guard) {
    case 'terminal_status_only':
      return { status: { in: ['delivered', 'read', 'failed'] } };
    case 'completed_only':
      return { status: { in: ['completed'] } };
    case 'expired_only':
      return { expiresAt: { lt: now } };
    case 'none':
    default:
      return {};
  }
};

/**
 * Human-readable statement of the policy, for the operations docs and the
 * report endpoint. Keeping this generated from the policy rather than written
 * separately is what stops the documented window and the enforced window from
 * drifting apart.
 */
const describePolicy = () => ({
  purged: PURGEABLE_MODELS.map((model) => ({
    model,
    retentionDays: RETENTION_POLICIES[model].retentionDays,
    action: RETENTION_POLICIES[model].action,
    guard: RETENTION_POLICIES[model].guard,
    notes: RETENTION_POLICIES[model].notes,
  })),
  neverPurged: Object.entries(NEVER_PURGED).map(([model, reason]) => ({ model, reason })),
});

module.exports = {
  RETENTION_POLICIES,
  NEVER_PURGED,
  PURGEABLE_MODELS,
  envDays,
  policyFor,
  isPurgeable,
  isNeverPurged,
  cutoffFor,
  guardClauseFor,
  describePolicy,
};
