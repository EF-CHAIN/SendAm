#!/usr/bin/env node
'use strict';

const { listDeadLetterJobs, getDeadLetterJob, replayDeadLetterJob } = require('../src/queues/dlq.service');
const queueService = require('../src/queues/queue.service');

const args = process.argv.slice(2);
const command = args[0] || 'list';

const parseArg = (flag, defaultValue) => {
  const index = args.indexOf(flag);
  if (index !== -1 && args[index + 1]) {
    return args[index + 1];
  }
  return defaultValue;
};

const isJson = args.includes('--json');
const actorId = parseArg('--actor', 'operator-cli');
const statusFilter = parseArg('--status', null);
const limitFilter = parseInt(parseArg('--limit', '50'), 10);

async function main() {
  try {
    if (command === 'list') {
      const jobs = await listDeadLetterJobs({ status: statusFilter, limit: limitFilter });
      if (isJson) {
        console.log(JSON.stringify(jobs, null, 2));
      } else {
        console.log(`\n=== WhatsApp Dead-Letter Queue (${jobs.length} jobs) ===\n`);
        if (jobs.length === 0) {
          console.log('No matching dead-letter jobs found.');
        } else {
          for (const job of jobs) {
            console.log(`[${job.status.toUpperCase()}] ID: ${job.id}`);
            console.log(`  Queue: ${job.queueName} | Original Job ID: ${job.originalJobId}`);
            console.log(`  Sender: ${job.sender} | Message ID: ${job.whatsappMessageId || 'N/A'}`);
            console.log(`  Reason: ${job.failureReason}`);
            console.log(`  Failed At: ${job.failedAt} (Attempts: ${job.attempts})`);
            console.log('---');
          }
        }
      }
    } else if (command === 'inspect') {
      const jobId = args[1];
      if (!jobId) {
        console.error('Error: Please specify a job ID to inspect.');
        process.exit(1);
      }
      const job = await getDeadLetterJob(jobId);
      if (!job) {
        console.error(`Error: DLQ job "${jobId}" not found.`);
        process.exit(1);
      }
      if (isJson) {
        console.log(JSON.stringify(job, null, 2));
      } else {
        console.log(`\n=== DLQ Job Details: ${job.id} ===`);
        console.log(`Status: ${job.status}`);
        console.log(`Queue: ${job.queueName}`);
        console.log(`Original Job ID: ${job.originalJobId}`);
        console.log(`Sender: ${job.sender}`);
        console.log(`Message ID: ${job.whatsappMessageId || 'N/A'}`);
        console.log(`Failure Reason: ${job.failureReason}`);
        console.log(`Attempts Made: ${job.attempts}`);
        console.log(`Failed At: ${job.failedAt}`);
        console.log('Payload (PII-Sanitized):', JSON.stringify(job.payload, null, 2));
      }
    } else if (command === 'replay') {
      const jobId = args[1];
      if (!jobId) {
        console.error('Error: Please specify a job ID to replay.');
        process.exit(1);
      }
      const result = await replayDeadLetterJob(jobId, {
        queueService,
        actorId,
        actorType: 'operator',
      });

      if (isJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (result.replayed) {
          console.log(`✅ Successfully replayed DLQ job ${jobId}. (Re-enqueued & Audit Log recorded)`);
        } else {
          console.log(`⚠️ Could not replay job ${jobId}: ${result.reason}`);
        }
      }
    } else {
      console.log(`Usage: node scripts/whatsapp-dlq.js <list|inspect|replay> [options]`);
      console.log(`  list                   List DLQ jobs (--status, --limit, --json)`);
      console.log(`  inspect <jobId>        Inspect a DLQ job (--json)`);
      console.log(`  replay <jobId>         Replay a DLQ job with idempotency & audit logging (--actor, --json)`);
    }
  } catch (error) {
    console.error(`DLQ CLI Error: ${error.message}`);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

main();
