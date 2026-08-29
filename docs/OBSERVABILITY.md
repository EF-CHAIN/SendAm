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

Prometheus must scrape `GET /metrics` with
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
