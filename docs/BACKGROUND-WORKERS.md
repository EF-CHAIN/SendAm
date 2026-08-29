# Background worker deployment

SendAm has two independently managed process types:

- `npm start --workspace=apps/api` runs the HTTP API. It validates webhooks and
  enqueues jobs, but never imports or starts a processor or poller.
- `npm run start:worker --workspace=apps/api` runs BullMQ processors and
  scheduled pollers. It does not bind an HTTP port.

The root `Procfile` provides matching `web` and `worker` process declarations
for platforms that support Procfiles.

## Configuration

Both processes need the normal API secrets and `DATABASE_URL`. Both must use
the same `REDIS_URL` or `UPSTASH_REDIS_URL`; production Redis must require
authentication and TLS. Worker-specific settings are:

```text
WORKER_CONCURRENCY=5
WORKER_LOCK_DURATION_MS=30000
WORKER_SHUTDOWN_TIMEOUT_MS=30000
WORKER_HEARTBEAT_INTERVAL_MS=60000
PROCESS_TYPE=worker
DATABASE_POOL_MAX=5
DATABASE_CONNECTION_TIMEOUT_MS=5000
DATABASE_POOL_TIMEOUT_MS=10000
```

`WORKER_CONCURRENCY` controls parallel WhatsApp jobs per worker instance.
Increase it only after measuring database, provider, and Stellar limits. The
lock duration must exceed normal processing time so BullMQ does not classify a
healthy job as stalled.

Local development must start both entry points when exercising webhooks. Tests
and explicit local harnesses can still register an inline processor, preserving
the old no-Redis testing path. The API now fails queue submission with `503`
when neither Redis nor an explicit inline processor exists; silently accepting
and losing the command is no longer supported.

## Reliability and idempotency

Inbound WhatsApp IDs are used as BullMQ job IDs, so repeated Meta deliveries
and enqueue retries resolve to the same durable job. Jobs use three attempts
with exponential backoff. The API records its database deduplication claim
before enqueue, but does not acknowledge Meta until Redis accepts the job. If
enqueue fails, it removes that claim and returns `503`, allowing Meta to retry.

BullMQ provides at-least-once delivery. A worker can finish an external action
and die before recording job completion, so processors must remain idempotent.
The payment path retains its database-backed message deduplication and atomic
payment claim; new processors that create financial effects must use a stable
provider idempotency key plus a unique database operation key. Never disable
retries to hide a non-idempotent processor.

Graceful shutdown pauses new work by closing BullMQ workers, stops pollers,
closes queue connections, then disconnects PostgreSQL. The platform termination
grace period must be greater than `WORKER_SHUTDOWN_TIMEOUT_MS`.

## Rollout

1. Provision shared Redis and configure identical Redis/database/provider
   secrets on API and worker services.
2. Deploy at least one worker using `start:worker`; wait for `worker_started`,
   `WhatsApp queue processor registered`, and recurring `worker_heartbeat`.
3. Deploy the API using `start`; verify `api_started`.
4. Send a controlled webhook and verify `queue_job_completed` with the same job
   ID. Confirm the conversation response and any resulting transaction once.
5. Scale workers independently. Do not scale the worker to zero while the API
   accepts traffic.

For a no-loss transition from the legacy combined process, start the new worker
before deploying the API-only release. A brief overlap is safe because BullMQ
coordinates consumers and job IDs are stable.

## Monitoring and recovery

Alert on:

- missing `worker_heartbeat` for two heartbeat intervals;
- `queue_worker_error`, sustained `queue_job_failed`, or a growing failed set;
- oldest waiting-job age above the user-response objective;
- Redis connection, memory, eviction, or persistence alarms;
- worker restart loops, stalled jobs, or shutdown timeouts.

Platform Engineering owns Redis, process scaling, alerts, and deploy drains.
Backend owners own processor idempotency and failed-job diagnosis. Compliance
and Payments owners approve replay of any job that may have crossed an external
financial boundary.

If workers fail, keep the API running only while Redis remains durable and queue
age stays within the recovery objective; restore workers and let BullMQ drain.
For poison jobs, inspect the redacted error and job ID, fix the processor, then
retry through BullMQ tooling. Never copy sensitive job payloads into tickets.
Before replaying a payment-related job, reconcile its database transaction and
provider idempotency key.

## Rollback

Roll back API and worker images together. To return temporarily to the legacy
combined deployment, first stop new worker instances, drain active jobs, then
deploy the previous API image. Never run both a legacy poller and the new poller
for longer than the controlled overlap. Redis jobs are forward-compatible
because queue and job names are unchanged; do not delete Redis or failed jobs
during rollback.

## Queue backup and restore drills

Redis-backed BullMQ state is part of the disaster-recovery plan because accepted
webhooks may be waiting, delayed, failed, or stalled when PostgreSQL is restored.
Platform Engineering owns Redis backup/PITR settings and validates them during
the **Verify restore drill** workflow. Backend owners own safe replay guidance,
and Compliance plus Payments must approve replay for jobs that may have crossed
an external financial boundary.

Queue recovery objectives are:

- **Redis queue-state RPO:** latest durable Redis snapshot or provider restore
  point must be no older than 30 minutes for BullMQ wait/delayed/failed sets.
- **Queue recovery RTO:** Redis restore and worker drain validation must fit
  inside the 60-minute application RTO.

During a drill, restore Redis into an isolated target and set
`RESTORE_DRILL_REDIS_URL`. The verifier summarizes BullMQ wait, delayed, and
failed counts without logging job payloads. If Redis cannot be restored, record
that dependency gap in the evidence and keep the PostgreSQL drill failed until a
queue recovery plan is proven.

After an incident restore, start workers only after PostgreSQL validation and
key access checks pass. Inspect failed or waiting jobs by redacted job ID, avoid
copying payloads into tickets, reconcile any payment-related transaction before
replay, and document the final queue depth in the incident evidence.
