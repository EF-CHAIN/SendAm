# Load testing and capacity limits

SendAm moves money on a path that starts with a webhook Meta will retry and
ends with a Stellar submission that must never happen twice. This document
describes how to generate repeatable load against the payment-critical paths,
what the pass/fail budgets are, and which signals mean "add capacity" rather
than "tune a query".

The harness lives in `apps/api/load/` and has no dependencies beyond what the
API already installs.

## Running it

```bash
# Everything, against a locally running API, with defaults
npm run load

# One scenario, heavier, for longer
npm run load -- --scenario webhook-burst --concurrency 100 --duration 60

# A fixed request count instead of a duration, for run-to-run comparison
npm run load -- --scenario duplicate-storm --iterations 5000

# Machine-readable, for diffing between runs
npm run load -- --json > run-$(date +%s).json
```

`npm run load -- --help` lists every flag. From inside `apps/api/` the same
command is `npm run load -- <options>`.

The harness exits `0` when every scenario met its budget, `1` when one did not,
and `2` when it refused to run at all (bad arguments, or a target it will not
point at). That makes it usable as a gate in a scheduled capacity job, not just
as something a human reads.

### It will not target production by default

Two independent locks, because they fail differently:

| Guard | Trips when | Unlock |
|---|---|---|
| Remote target | the target host is not `localhost`/`127.0.0.1`/`[::1]`/`0.0.0.0`/`host.docker.internal` | `LOAD_ALLOW_REMOTE=true` |
| Production process | `NODE_ENV=production` | `LOAD_ALLOW_PRODUCTION=true` |

Opting into one does not unlock the other. The default target is
`http://127.0.0.1:3002`. Point the harness at a staging environment you own, or
at a local stack — never at the environment serving real users.

### Environment

| Variable | Effect when set |
|---|---|
| `LOAD_TARGET` | Base URL (same as `--target`) |
| `WHATSAPP_APP_SECRET` | Signs webhook payloads, so runs exercise the real signature-verification middleware instead of the development bypass |
| `LOAD_ADMIN_TOKEN` | Bearer token for `admin-read`; **required** — the scenario refuses to run without it |
| `REDIS_URL` | Enables queue depth and oldest-job-age sampling; required by queue-backed scenarios |
| `DATABASE_URL` | Seeds accounts for the money-movement scenarios and samples `pg_stat_activity` connections |
| `PIN_PEPPER` | Must match the API's, so seeded PINs verify |
| `LOAD_METRICS_TOKEN` | Bearer token for `/metrics`, enabling process-memory sampling |

A missing measurement is never reported as a healthy one. Without `REDIS_URL`
the report states that queue lag was **not measured**, and for the queue-backed
scenarios that is a failed run rather than a skipped check.

### An isolated environment

Run against a stack with external providers stubbed: Postgres and Redis local
or containerised (`docker-compose.yml` provides Postgres; Redis can be any local
instance), `MESSAGE_TRANSPORT=sim` so no messages reach Meta, and Stellar
pointed at testnet.

```bash
docker run -d --name sendam-load-pg -e POSTGRES_USER=sendam -e POSTGRES_PASSWORD=sendam \
  -e POSTGRES_DB=sendam -p 55432:5432 postgres:16
docker run -d --name sendam-load-redis -p 56379:6379 redis:7-alpine

export DATABASE_URL=postgresql://sendam:sendam@127.0.0.1:55432/sendam
export REDIS_URL=redis://127.0.0.1:56379
npm run prisma:deploy --workspace=apps/api
npm run start --workspace=apps/api &          # API
npm run start:worker --workspace=apps/api &   # worker, so the queue drains
```

Seeded accounts use a run-scoped `+2348NNNNxxxx` prefix and are deleted when the
run finishes, including on failure — so a shared staging database does not
accumulate synthetic users.

## Scenarios

| Scenario | What it models | Why it is payment-critical | Needs |
|---|---|---|---|
| `webhook-burst` | Many senders delivering independent messages at once | Meta retries anything it cannot deliver promptly and will mark a slow webhook unhealthy | Redis |
| `sender-sequence` | One sender working through greeting → balance → send → history | Exercises per-sender throttling and the conversational state machine | Redis |
| `duplicate-storm` | The same message id redelivered concurrently | The dedup claim is what stops a Meta retry becoming a double payment | Redis |
| `payment-confirmation` | The PIN reply that actually debits a wallet and submits to Stellar | This is the leg where a duplicate is a double spend | Redis, `DATABASE_URL` |
| `deposit-sweep` | Wallet balance/history reads while the deposit poller sweeps | Deposit notification competes with user-facing reads; the balance path reaches Horizon | `DATABASE_URL` |
| `admin-read` | Concurrent operators loading stats, users, transactions | The heaviest database reads in the product; they compete with payment writes | `LOAD_ADMIN_TOKEN` |
| `health-read` | Liveness, including its database round trip | The floor every other number is measured against | — |

Deposits have no HTTP entry point — `jobs/deposits.jobs.js` is an in-process
poller. `deposit-sweep` therefore grows the wallet population that poller sweeps
and measures the read path it competes with, rather than inventing an endpoint
that does not exist.

### A scenario that cannot measure its subject fails

A run missing a precondition is a **failure**, not a skip:

- `admin-read` without `LOAD_ADMIN_TOKEN` refuses to run. Measuring the 401 path
  would report excellent latency for requests that never touched an admin query.
- `payment-confirmation` / `deposit-sweep` without `DATABASE_URL` refuse to run,
  because unseeded users short-circuit on validation.
- Queue-backed scenarios without `REDIS_URL` fail on an explicit `queue lag`
  check. These acknowledge at the edge and finish on a queue; passing them on
  HTTP numbers alone would certify a service whose backlog nobody looked at.
- Database-bound scenarios without observable connections fail the same way.

The harness also detects the most common way a load run produces meaningless
numbers: if more than half of responses are `429`, it fails the run with
`rate limit wall` and tells you to raise `RATE_LIMIT_MAX` in the environment
under test. Rejecting a request is cheap, so a rate-limited run otherwise looks
like a beautifully fast service that did no work. **This bites immediately** —
the default `RATE_LIMIT_MAX=100` per 15 minutes per IP means the 101st request
of any `/api/` run is throttled.

## Budgets

Defined in `apps/api/load/lib/budgets.js`; the harness fails a run that breaches
one. These are **derived from the measured baseline below**, not guessed:
latency ceilings sit at roughly 4x the measured p99 and throughput floors at
roughly 25% of measured throughput, so slower hardware still passes while a real
regression cannot hide inside the headroom.

| Scenario | p95 | p99 | Max error rate | Min throughput |
|---|---|---|---|---|
| `webhook-burst` | 100ms | 250ms | 0.1% | 400 rps |
| `sender-sequence` | 100ms | 200ms | 2% | 400 rps |
| `duplicate-storm` | 300ms | 800ms | 0% | 150 rps |
| `payment-confirmation` | 250ms | 500ms | 0% | 150 rps |
| `deposit-sweep` | 1000ms | 2500ms | 1% | 25 rps |
| `admin-read` | 100ms | 200ms | 0.1% | 300 rps |
| `health-read` | 50ms | 100ms | 0% | 1000 rps |

Resource ceilings, applied to every scenario that can observe them: **database
connection utilisation ≤ 80%**, **peak RSS ≤ 1024MB**. Queue lag, when Redis is
configured: **depth ≤ 500 jobs**, **oldest waiting job ≤ 30s**.

Two notes on the numbers. `sender-sequence` tolerates a higher non-2xx share
because per-sender throttling deliberately drops excess messages — that is the
feature working. `duplicate-storm` tolerates none: contention on the dedup claim
must never surface as a failed request, because Meta reads a 5xx as an unhealthy
webhook.

## Measured baseline

Full stack, all external providers local or stubbed:

- Postgres 16 and Redis 7 in containers, API and worker as separate Node
  processes, `MESSAGE_TRANSPORT=sim`, Stellar on testnet
- Apple Silicon laptop, Node 24, `max_connections=100`
- 25 virtual users, 8s measured per scenario, 20 warmup requests discarded
- `RATE_LIMIT_MAX` raised in the environment under test (see above)

| Scenario | Throughput | p50 | p95 | p99 | Errors | Queue depth | Peak DB conns | Peak RSS |
|---|---|---|---|---|---|---|---|---|
| `webhook-burst` | 1634/s | 13.3ms | 24.5ms | 53.2ms | 0% | 0 | 16/100 | 316MB |
| `sender-sequence` | 1594/s | 14.6ms | 21.7ms | 31.4ms | 0% | 0 | 16/100 | 317MB |
| `duplicate-storm` | 699/s | 27.7ms | 71.4ms | 202.7ms | 0% | 0 | 14/100 | 320MB |
| `payment-confirmation` | 765/s | 29.9ms | 50.1ms | 77.1ms | 0% | 0 | 14/100 | 318MB |
| `deposit-sweep` | 163/s | 106.4ms | 292.4ms | 783.4ms | 0% | 0 | 15/100 | 309MB |
| `admin-read` | 1570/s | 15.0ms | 22.4ms | 33.2ms | 0% | 0 | 15/100 | 338MB |
| `health-read` | 8576/s | 2.3ms | 6.1ms | 12.2ms | 0% | 0 | 15/100 | 331MB |

What this baseline says:

- **`duplicate-storm` is the slowest webhook path** (p99 203ms against 53ms for
  independent messages). Every virtual user contends on the same
  `ProcessedMessage` rows. That is the idempotency guarantee costing what it
  should cost, not a defect — but it means a redelivery storm is roughly 4x more
  expensive per message than ordinary traffic, which is worth knowing when
  sizing for a Meta retry burst.
- **`deposit-sweep` is an order of magnitude slower than every other read**
  (p99 783ms) because the balance path reaches Horizon. That latency is not this
  service's to fix; it is a reason not to put Horizon in a user-facing read path
  without a cache.
- **The database was never the constraint.** Peak connection use stayed at
  14–16 of 100 across every scenario. At this concurrency the bottleneck is
  application CPU and the Horizon round trip, not the pool.
- **Memory was flat** at ~310–340MB regardless of scenario, with no growth
  across runs.

### The knee

Stepping `webhook-burst` up while holding everything else constant:

| Concurrency | Throughput | p50 | p95 | p99 | Peak DB conns |
|---|---|---|---|---|---|
| 5 | 1282/s | 3.5ms | 5.7ms | 9.2ms | 8 |
| 10 | 1374/s | 6.1ms | 14.0ms | 23.6ms | 14 |
| 25 | 1663/s | 12.9ms | 19.7ms | 45.9ms | 14 |
| 50 | 1658/s | 26.5ms | 48.5ms | 97.2ms | 16 |
| 100 | 1879/s | 51.1ms | 67.2ms | 80.8ms | 16 |
| 200 | 1881/s | 102.6ms | 125.6ms | 141.3ms | 16 |

Throughput plateaus around **25 concurrent** — past that it gains under 15%
while p50 grows almost linearly with concurrency, which is the signature of
requests queueing rather than being served faster. **25 is the knee**, and the
baseline above was taken there.

Production headroom: size for roughly **800 rps of webhook traffic per API
instance**, half the measured plateau, so a burst has somewhere to go while
autoscaling reacts.

### Calibrating on real hardware

1. Bring up an isolated stack with production-shaped data volumes. Aggregate
   queries behave differently against 100 rows than against 100,000.
2. Run each scenario at low concurrency (`-c 5`) to establish an unloaded
   baseline. `health-read` p50 is your floor — no other path can beat a bare
   database round trip.
3. Step concurrency up (10, 25, 50, 100, 200), holding duration constant, and
   record throughput and p99 at each step.
4. Find the knee: the concurrency past which throughput stops rising but p99
   keeps climbing. That is the saturation point.
5. Set budgets at roughly 50% of the knee. That headroom absorbs a burst without
   the service falling over while autoscaling reacts.

## Capacity settings

These are the knobs the measurements above should decide. All live in
`apps/api/src/config/env.js` and are documented in `.env.example`.

| Setting | Default | What it trades off |
|---|---|---|
| `WORKER_CONCURRENCY` | 5 | Jobs in parallel per worker process. Each holds a database connection for part of its life, so this must stay **below** the per-process Prisma pool size, or jobs queue on connections instead of doing work |
| `WORKER_LOCK_DURATION_MS` | 30000 | How long a job may run before BullMQ assumes the worker died. Must exceed the slowest realistic job — a Horizon submission plus retries — or the same payment is processed twice |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MIN` | 100 / 15min | REST traffic per IP |
| `BOT_RATE_MAX` / `BOT_RATE_WINDOW_SEC` | 20 / 60s | Inbound WhatsApp messages per sender |

The two worker settings interact with the database pool and with each other:
raising `WORKER_CONCURRENCY` without raising the pool converts queue lag into
connection-wait latency, which looks like a slow database rather than an
undersized pool. Measure both.

See `docs/BACKGROUND-WORKERS.md` for how the worker process is deployed.

## Scaling signals and what to do about them

Read these in order — the first matching row is usually the real bottleneck.

| Signal | Likely cause | Remediation |
|---|---|---|
| Queue depth grows steadily while webhook p99 stays flat | Consumers are undersized; the edge is fine | Add worker processes first; raise `WORKER_CONCURRENCY` only if the database pool has room |
| Oldest job age climbs but depth is flat | A few slow jobs are blocking; likely Horizon latency | Check Stellar submission latency; consider a separate queue so slow submissions do not head-of-line-block fast replies |
| Webhook p99 climbs while p50 stays flat | Tail contention — usually the dedup insert or connection acquisition | Check `ProcessedMessage` index health and pool saturation before adding instances |
| Both p50 and p99 climb together | The service is genuinely saturated | Add API instances; the webhook path is stateless and scales horizontally |
| Error rate rises with `ECONNREFUSED`/`timeout` | Connection or file-descriptor exhaustion | Check pool size, ulimits, and Redis `maxclients` |
| `admin-read` degrades while webhook paths are healthy | Unbounded aggregate queries competing with payment writes | Paginate and index the admin queries; consider a read replica |
| 503s from the webhook under duplicate load | Working as designed — a concurrent request holds the dedup claim | Nothing, unless the rate is rising; then look at claim-holding duration |

## Idempotency under concurrency

The invariant that matters most is not a latency number: **one message id must
produce at most one payment**, no matter how many times Meta redelivers it or
how many instances receive it simultaneously.

`duplicate-storm` exercises this against a running service and asserts it stays
responsive without 5xx-ing while the contention happens. The exactly-once
property itself is asserted deterministically in
`apps/api/test/load.idempotency.test.js`, which fires 50 simultaneous deliveries
of one message id at the real controller and asserts exactly one reaches the
queue. That test runs in normal CI, so the invariant is protected on every PR
rather than only when someone remembers to run a load test.

There are two independent defences, and the tests cover both: the unique index
on `ProcessedMessage.messageId`, and BullMQ's own deduplication on `jobId`,
which the controller sets to the WhatsApp message id.
