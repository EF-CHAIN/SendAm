'use strict';

/**
 * @fileoverview Dead-Letter Queue manager.
 *
 * Sits on top of dlq.service (storage, redaction, idempotent replay) and adds
 * the operator-facing behaviour:
 *   - a permanently failed job is moved to the DLQ exactly once;
 *   - a Slack / Discord / generic webhook alert is sent with the error stack
 *     trace (redacted, never the job payload);
 *   - inspect / requeue helpers shared by the admin API and the CLI
 *     (scripts/whatsapp-dlq.js), so a fixed job is re-run without touching the
 *     database by hand.
 */

const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');
const { increment } = require('../observability/metrics');
const { redact } = require('../../test/contract/helpers');
const dlq = require('./dlq.service');

const SLACK_TEXT_LIMIT = 3000;
const DISCORD_TEXT_LIMIT = 2000;
const STACK_LIMIT = 1200;

// Both the BullMQ `failed` event and the processor wrapper can report the same
// exhausted job; remember recent ones so it is stored and alerted once.
const RECENT_LIMIT = 500;
const recentlyHandled = new Set();

const markHandled = (key) => {
  if (recentlyHandled.has(key)) return false;
  recentlyHandled.add(key);
  if (recentlyHandled.size > RECENT_LIMIT) {
    recentlyHandled.delete(recentlyHandled.values().next().value);
  }
  return true;
};

const alertSettings = () => ({
  url: config.observability?.dlqAlertWebhookUrl || config.observability?.errorMonitorWebhookUrl || '',
  token: config.observability?.errorMonitorToken,
  timeoutMs: config.observability?.errorMonitorTimeoutMs || 3000,
});

const truncate = (text, limit) => (text.length > limit ? `${text.slice(0, limit - 3)}...` : text);

/**
 * Webhook flavour from the URL: Discord and Slack want different bodies.
 * @param {string} url
 * @returns {'discord'|'slack'|'generic'}
 */
const detectWebhookKind = (url) => {
  if (/discord(app)?\.com\/api\/webhooks\//i.test(url)) return 'discord';
  if (/hooks\.slack\.com\//i.test(url)) return 'slack';
  return 'generic';
};

/**
 * Build the (redacted) alert body for a DLQ record.
 *
 * @param {object} record - record returned by moveToDeadLetterQueue.
 * @param {'discord'|'slack'|'generic'} kind
 * @returns {object} JSON body for the webhook.
 */
const buildAlertPayload = (record, kind = 'generic') => {
  const stack = record.failureStack ? truncate(record.failureStack, STACK_LIMIT) : '(no stack trace)';
  const lines = [
    'Dead-letter job: retries exhausted',
    `DLQ id: ${record.id}`,
    `Queue: ${record.queueName} | Job: ${record.jobName} (${record.originalJobId})`,
    `Attempts: ${record.attempts} | Failed at: ${record.failedAt}`,
    `Reason: ${record.failureReason}`,
    `Requeue: node scripts/whatsapp-dlq.js replay ${record.id}`,
  ];
  const header = lines.join('\n');
  const limit = kind === 'discord' ? DISCORD_TEXT_LIMIT : SLACK_TEXT_LIMIT;
  const withStack = `${header}\n\`\`\`\n${stack}\n\`\`\``;
  const text = truncate(withStack, limit);

  if (kind === 'discord') return { content: text };
  if (kind === 'slack') return { text };
  return {
    text,
    event: 'dlq.job_failed',
    dlqId: record.id,
    queue: record.queueName,
    jobName: record.jobName,
    originalJobId: record.originalJobId,
    attempts: record.attempts,
    failedAt: record.failedAt,
    reason: record.failureReason,
    stack,
  };
};

/**
 * Notify operators about a dead-lettered job. Never throws: an unreachable
 * webhook must not disturb job processing.
 *
 * @param {object} record
 * @param {{ post?: Function }} [deps] - injectable HTTP client for tests.
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
const sendDlqAlert = async (record, deps = {}) => {
  const { url, token, timeoutMs } = alertSettings();
  if (!url) {
    increment('sendam_dlq_alerts_total', { status: 'skipped' });
    return { sent: false, reason: 'no_webhook_configured' };
  }
  const post = deps.post || axios.post.bind(axios);
  try {
    await post(url, buildAlertPayload(record, detectWebhookKind(url)), {
      timeout: timeoutMs,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    increment('sendam_dlq_alerts_total', { status: 'sent' });
    return { sent: true };
  } catch (error) {
    increment('sendam_dlq_alerts_total', { status: 'failed' });
    logger.error('dlq_alert_failed', { dlqId: record.id, message: redact(error?.message || String(error)) });
    return { sent: false, reason: 'delivery_failed' };
  }
};

/**
 * Handle a job that exhausted its retries: store it in the DLQ and alert.
 * Safe to call more than once for the same job/attempt.
 *
 * @param {object} job - BullMQ job.
 * @param {Error|string} error
 * @param {{ queueName?: string, post?: Function }} [options]
 * @returns {Promise<{ record: object|null, duplicate: boolean, alert?: object }>}
 */
const handleExhaustedJob = async (job, error, options = {}) => {
  const queueName = options.queueName || 'whatsapp-inbound';
  const key = `${queueName}:${job?.id ?? 'unknown'}:${job?.attemptsMade ?? ''}`;
  if (job?.id != null && !markHandled(key)) return { record: null, duplicate: true };

  const record = await dlq.moveToDeadLetterQueue(job, error, { queueName });
  increment('sendam_dlq_jobs_total', { queue: queueName });
  const alert = await sendDlqAlert(record, { post: options.post });
  return { record, duplicate: false, alert };
};

/**
 * Operator view of a DLQ job: everything needed to diagnose it, minus the raw
 * (unredacted) payload.
 *
 * @param {string} id
 * @returns {Promise<object|null>}
 */
const inspectJob = async (id) => {
  const record = await dlq.getDeadLetterJob(id);
  if (!record) return null;
  // eslint-disable-next-line no-unused-vars
  const { rawPayload, ...safe } = record;
  return { ...safe, payload: dlq.sanitizePayload(record.payload) };
};

/**
 * Re-queue one DLQ job. Uses the real queue service unless one is injected, so
 * callers (admin API, CLI) cannot accidentally "replay" without enqueueing.
 *
 * @param {string} id
 * @param {{ queueService?: object, actorId?: string, actorType?: string }} [options]
 */
const requeueJob = async (id, options = {}) => {
  const queueService = options.queueService || require('./queue.service');
  return dlq.replayDeadLetterJob(id, {
    queueService,
    actorId: options.actorId || 'dlq-operator',
    actorType: options.actorType || 'operator',
  });
};

/**
 * Re-queue every pending DLQ job (oldest first), e.g. after deploying a fix.
 * Each job still goes through the per-job idempotency check.
 *
 * @param {{ limit?: number, queueService?: object, actorId?: string }} [options]
 * @returns {Promise<{ total: number, replayed: number, skipped: number, failed: number }>}
 */
const requeueAllPending = async (options = {}) => {
  const pending = await dlq.listDeadLetterJobs({ status: 'pending', limit: options.limit || 100 });
  const summary = { total: pending.length, replayed: 0, skipped: 0, failed: 0 };
  for (const job of [...pending].reverse()) {
    try {
      const result = await requeueJob(job.id, options);
      if (result.replayed) summary.replayed += 1;
      else summary.skipped += 1;
    } catch (error) {
      summary.failed += 1;
      logger.error('dlq_requeue_failed', { dlqId: job.id, message: redact(error?.message || String(error)) });
    }
  }
  return summary;
};

/** Test helper: forget which jobs were already handled. */
const resetHandledJobs = () => recentlyHandled.clear();

module.exports = {
  detectWebhookKind,
  buildAlertPayload,
  sendDlqAlert,
  handleExhaustedJob,
  inspectJob,
  requeueJob,
  requeueAllPending,
  resetHandledJobs,
};
