# Production observability

SendAm emits correlated JSON logs, Prometheus metrics, and redacted exception
events from both HTTP requests and BullMQ jobs. The implementation has no
external telemetry SDK dependency: Prometheus scrapes the API, and exceptions
are delivered to the configured HTTPS error-monitoring or alert-router webhook.

## Configuration

```text
SERVICE_NAME=sendam-api
RELEASE_SHA=<immutable deployment commit>
METRICS_TOKEN=<random value, at least 32 characters>
ERROR_MONITOR_WEBHOOK_URL=https://alerts.example.com/sendam
ERROR_MONITOR_TOKEN=<optional bearer credential>
ERROR_MONITOR_TIMEOUT_MS=3000
```

Production startup rejects missing/short metrics credentials, a missing error
monitor, or a non-HTTPS error-monitor URL. Configure the same release and alert
routing on worker deployments, using `SERVICE_NAME=sendam-worker`.

Prometheus must scrape API `GET :3002/metrics` and every worker replica's
`GET :3003/metrics` with
`Authorization: Bearer <METRICS_TOKEN>`. Never place the token in the URL.
Import `observability/grafana-dashboard.json`, load
`observability/prometheus-rules.yml`, and replace the example Alertmanager
receiver URLs with secrets managed by the monitoring platform.

## Telemetry contract

Every API response includes `x-correlation-id`. A safe caller-provided
`x-correlation-id` or `x-request-id` is preserved; malformed values are replaced
with a UUID. The correlation ID also appears inside the JSON body of every
response so clients can match a failure to logs without reading headers. Queue
enqueueing copies the correlation ID into the job payload, the processor
restores it along with `jobId` and queue name, and outbound provider calls
(Smile ID, WhatsApp, Stellar/Friendbot, Deepgram, exchange-rate API) attach it
as an `x-correlation-id` header so provider-side logs can be correlated too.

## Error envelope

API error responses use a versioned envelope with a stable machine-readable
code (see `apps/api/src/errors/catalog.js`):

```jsonc
{
  "success": false,
  "message": "…",
  "correlationId": "…",
  "error": {
    "version": "1.0",
    "code": "validation_error",
    "message": "…",
    "correlationId": "…"
  }
}
```

Codes are mapped from validation (400), auth (401/403), not-found (404),
conflict (409), rate-limit (429), provider (502), unavailable (503), and
internal (500) failures. `internal_error` responses always use a generic
message — the real error is logged and reported to the monitor but never
returned to the client. Clients should branch on `error.code`, never on the
human-readable `message`.

Production logs are one JSON object per line with timestamp, level, service,
environment, correlation fields, message, and structured data/error fields.
The logger recursively redacts PINs, passwords, tokens, cookies, authorization,
signatures, API keys, private/encrypted keys, DSNs, and secret-bearing text.
Buffers are represented by length only and circular objects are safe.

The primary metrics are:

- `sendam_http_requests_total`
- `sendam_http_request_duration_seconds`
- `sendam_exceptions_total`
- `sendam_queue_jobs_total`
- `sendam_queue_job_duration_seconds`
- `sendam_queue_jobs` and `sendam_queue_oldest_job_age_seconds`
- `sendam_worker_ready` and `sendam_worker_heartbeat_age_seconds`
- `sendam_worker_last_successful_processing_timestamp_seconds`
- `sendam_deposit_sweep_age_seconds`
- `sendam_webhook_events_total`
- `sendam_health_checks_total`
- process uptime and resident memory gauges

Redis availability and recovery signals (see
`apps/api/src/config/redis.js` and `test/redis.safeguards.test.js`):

- `sendam_redis_status` (gauge, 1 = serving/ready) — quick health at a glance.
- `sendam_redis_disconnects_total` — unexpected Redis disconnects.
- `sendam_redis_reconnects_total` — reconnect attempts with backoff.
- `sendam_redis_disconnect_recovered_total` — returns to serving after a drop.
- `sendam_redis_recovery_seconds` (histogram) — measured outage duration.
- `sendam_redis_failovers_total` — Sentinel failover to a new master.
- `sendam_redis_retries_exhausted_total` — reconnect budget exhausted.
- `sendam_redis_errors_total` — client-level Redis errors.
- `sendam_queue_inline_fallback_total` — accepted jobs running inline instead
  of durably queued (Redis unavailable). This constitutes an operator alert,
  never a silent drop.

Labels are deliberately bounded to method, route, status, queue, and outcome.
Do not add phone numbers, wallet addresses, transaction IDs, job IDs, or
correlation IDs as metric labels.

## Admin system health endpoint

The admin dashboard's Health page (route `/system-health`, sidebar label
"Health") reads `GET /api/admin/system-health`. The route is registered in
`apps/api/src/routes/admin.routes.js` behind `requireAdmin('operations.write')`,
and the sidebar entry is filtered by the same permission, so a session without
`operations.write` neither sees the link nor reaches the handler.

### Response envelope

The handler (`getSystemHealth` in
[`apps/api/src/controllers/admin.controller.js`](../apps/api/src/controllers/admin.controller.js))
replies through `sendSuccess`, so the payload is wrapped in the same success
envelope every other admin endpoint uses:

```jsonc
{
  "success": true,
  "message": "Success",
  "data": {
    "api": "ok",
    "database": "ok",
    "queues": "redis-configured",
    "settlementRail": "stellar",
    "custodyModel": "direct",
    "timestamp": "2026-10-05T02:25:27.469Z"
  },
  "correlationId": "…"
}
```

`apps/admin/src/lib/adminApi.js` unwraps one level (`data`), and
`apps/admin/src/pages/SystemHealth.jsx` renders `Object.entries(health)` — one
card per key, with the key as the label and `String(value)` as the body. A field
added to the handler therefore shows up in the UI with no frontend change.

### Field semantics

| Field | Meaning |
| --- | --- |
| `api` | Constant `ok` — the process answered the request. |
| `database` | Constant `ok` — the handler does not probe Postgres. |
| `queues` | `redis-configured` when `REDIS_URL` or `UPSTASH_REDIS_URL` is set, otherwise `unavailable`. |
| `settlementRail` | Constant `stellar`. |
| `custodyModel` | Constant `direct`. |
| `timestamp` | ISO 8601 UTC timestamp taken when the handler ran. |

### Health criteria and thresholds

This endpoint reports configuration, not measured health: `api` and `database`
are constants and `queues` only reflects whether a Redis URL is present, so a
failing dependency does not change the response. It does not classify a
deployment as healthy, degraded, or unhealthy, and the admin page does not
derive a classification either — it prints the strings it is given.

Numeric health thresholds live in Prometheus, not in this handler:

| Signal | Warning | Critical | Alert |
| --- | --- | --- | --- |
| Queue backlog (`sendam_queue_backlog_size`) | over 50 jobs for 5m | over 200 jobs for 2m | `SendAmQueueBacklogWarning` / `SendAmQueueBacklogCritical` |
| Queue lag (`sendam_queue_lag_seconds`) | over 300s for 5m | — | `SendAmQueueJobLagHigh` |
| Oldest job age (`sendam_queue_oldest_job_age_seconds`) | — | over 120s for 5m | `SendAmQueueLagHigh` |
| Failed jobs (`sendam_queue_jobs_total` with `status="failed"`) | — | over 5 in 10m for 5m | `SendAmQueueFailures` |
| Redis availability (`sendam_redis_status`) | — | `0` for 2m | `SendAmRedisDisconnected` |
| Database health checks (`sendam_health_checks_total` with `status="degraded"`) | — | any increase in 5m for 1m | `SendAmDatabaseHealthDegraded` |
| Worker heartbeat | — | stale over 90s for 1m | `SendAmWorkerHeartbeatStale` |
| Deposit sweep age (`sendam_deposit_sweep_age_seconds`) | — | over 120s for 3m | `SendAmDepositSweepStale` |

These thresholds are declared in `observability/prometheus-rules.yml`; change
them there rather than in the admin handler.

For a dependency-aware probe, use the public `GET /health` endpoint (also served
as `/health/ready`). It runs `SELECT 1` against Postgres and pings Redis in
parallel under a `HEALTH_CHECK_TIMEOUT_MS` budget (1000 ms by default), and
answers:

- `200` — `{"status": "ok", "db": "connected", "redis": "connected", "uptime": …}`
- `503` — `{"status": "degraded", "db": "unknown", "redis": "unknown", "uptime": …}`, returned when either probe fails or the budget expires.

Either outcome increments `sendam_health_checks_total` with `status="ok"` or
`status="degraded"`, which is what `SendAmDatabaseHealthDegraded` alerts on.

### Payload used by the frontend mock

The default msw handler in `apps/admin/src/mocks/handlers.js` answers this URL
with `{ database, redis, horizon, queue }`, which is not the shape above. Tests
that need the production contract override it — see
[`apps/admin/src/pages/SystemHealth.test.jsx`](../apps/admin/src/pages/SystemHealth.test.jsx),
whose payload mirrors the real handler.

## Rollout

1. Provision the protected metrics token and error-monitor endpoint in staging.
2. Deploy and confirm `/health`, an authenticated `/metrics` scrape, and a 403
   for a wrong metrics token.
3. Exercise an API request and queued webhook job. Search both logs using the
   response correlation ID and confirm the queue log has the same ID.
4. Trigger a controlled non-financial exception and verify the alert payload,
   release, environment, and correlation ID without secrets.
5. Import the dashboard and alert rules. Route warnings to Operations and
   critical alerts to the on-call receiver; send test and resolved alerts.
6. Repeat in production, then monitor error rate, p95 latency, queue failures,
   and alert delivery for one normal traffic window.

Existing logger calls remain source-compatible. Production output intentionally
changes from prefixed human-readable text to JSON; update log-drain parsers
before rollout. Development also emits JSON while retaining Morgan's local
request line.

## Monitoring ownership

Platform Engineering owns scrape availability, retention, dashboards,
Alertmanager, credentials, and log ingestion. Backend Engineering owns metric
semantics, correlation propagation, redaction tests, and exception triage.
Payments/Compliance must join incidents involving financial or KYC operations.

Alert delivery itself must be monitored. Run a synthetic alert at least weekly,
and alert through an independent channel when Prometheus, Alertmanager, the log
drain, or the error-monitor endpoint is unavailable.

## Operator recovery

### API down

Check platform health, startup JSON events, database/Redis connectivity, and the
latest release. Roll back if failures begin at deployment. Preserve logs and
correlation IDs before restarting.

### High HTTP error rate

Group `http_request_exception` logs by route and release, then follow one
correlation ID through API and queue logs. Check provider health and database
errors. Do not retry financial operations until their transaction/provider
idempotency keys are reconciled.

### Exception spike

Use `source`, release, and correlation ID from the error-monitor payload.
Confirm redaction before copying an event to a ticket. Contain the affected
route or worker, preserve failed jobs, and escalate according to data/financial
impact.

### Queue failures

Inspect failures by queue and job ID in structured logs. Check Redis and
downstream providers. Reconcile payments before replaying; never bulk-retry a
financial queue solely to clear an alert.

### Redis disconnected

On `SendAmRedisDisconnected`, the client enters exponential bounded reconnect
backoff; BullMQ and the DLQ keep buffering and replay accepted work once Redis
returns, so nothing durable is silently dropped. Confirm the endpoint, TLS
(`rediss://` / `REDIS_CA` / `REDIS_TLS`), timeouts, and Sentinel topology. If
`sendam_redis_retries_exhausted_total` fires, reconnects have stopped by policy —
verify Redis is reachable, then restart the affected process so it reconnects.

`SendAmRedisFailover` means Sentinel promoted a new master; confirm replicas are
up to date before resuming financial traffic. `SendAmQueueInlineFallback` means
jobs are being executed in-process rather than durably queued because Redis is
down or unconfigured — treat it as a degradation and restore Redis rather than
relying on the fallback. On `SendAmRedisRecovery`, confirm the buffered work
drained and reconcile any pendings before clearing the incident.

### Worker unhealthy

Check the worker target independently of API health. A missing target means the
process or probe server is down; `sendam_worker_ready=0` identifies dependency,
processor-registration, heartbeat, or shutdown failures through `/ready`.
Compare queue lag and the last successful processing timestamp to distinguish
an idle worker from a wedged one. Check deposit-sweep age separately because it
does not run through BullMQ. Restore Redis/database connectivity or roll back;
reconcile financial side effects before replaying stalled or failed jobs.

If metrics return 403, rotate and synchronize the scrape/API metrics token. If
error-monitor delivery fails, use JSON logs and Prometheus alerts as the
fallback and restore the routing endpoint before closing the incident.

## Rollback

Restore the previous application image while leaving monitoring configuration
available. Revert log parser changes only after the old image is serving.
Dashboard and alert rules are additive and can remain. If telemetry itself
causes instability, disable scraping at Prometheus rather than exposing an
unprotected endpoint, and point `ERROR_MONITOR_WEBHOOK_URL` to a healthy
fallback receiver. Validate `/health`, financial reconciliation, and alert
routing after rollback.

### Queue backlog

Fires when `sendam_queue_backlog_size` exceeds warning (50) or critical (200) thresholds.
1. Check worker process health (`pm2 status`, `kubectl get pods -l app=sendam-worker`).
2. Scale worker concurrency via `WORKER_CONCURRENCY` or add worker replicas.
3. Verify downstream API/blockchain latency (Stellar Horizon, Meta WhatsApp webhook).

### Queue lag

Fires when `sendam_queue_lag_seconds` exceeds 300s (5 minutes).
1. Inspect oldest pending job timestamp to identify stuck processors or blocking I/O calls.
2. Check Redis connection latency with `redis-cli --latency`.
3. Restart worker instances if deadlock or unhandled promise rejection is detected.

### Dead-letter queue (DLQ)

Fires on `SendAmDeadLetterQueueGrowing` when repeated job failures move to the dead-letter queue.
1. Inspect DLQ messages with `node apps/api/scripts/whatsapp-dlq.js inspect`.
2. Fix underlying provider errors before replaying: `node apps/api/scripts/whatsapp-dlq.js replay`.
