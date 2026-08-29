const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rules = fs.readFileSync(path.resolve(__dirname, '../../../observability/prometheus-rules.yml'), 'utf8');

test('alerts distinguish API availability from worker availability', () => {
  assert.match(rules, /alert: SendAmApiDown[\s\S]*up\{job="sendam-api"\}/);
  assert.match(rules, /alert: SendAmWorkerDown[\s\S]*up\{job="sendam-worker"\}/);
  assert.match(rules, /alert: SendAmWorkerNotReady[\s\S]*sendam_worker_ready == 0/);
});

test('alerts cover wedged queues and stale deposit sweeps', () => {
  assert.match(rules, /alert: SendAmQueueLagHigh[\s\S]*sendam_queue_oldest_job_age_seconds/);
  assert.match(rules, /alert: SendAmQueueStalled[\s\S]*sendam_queue_stalled_jobs_total/);
  assert.match(rules, /alert: SendAmDepositSweepStale[\s\S]*sendam_deposit_sweep_age_seconds/);
});
