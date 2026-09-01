# Continuous alert-delivery verification

> **Issue #228 — Continuously test alert delivery.** Monitoring can look healthy
> while the alert-routing pipeline is actually broken. This feature proves the
> real outbound alert path works end-to-end on a schedule instead of merely
> checking that components are running.

SendAm's only production alert/notification channel is the WhatsApp outbound
pipe (`sendTextMessage` / `sendTemplateMessage` via the Meta Cloud API). This
verification system continuously proves that pipe works by dispatching
clearly-marked **synthetic** test messages to an internal operator number
through the real outbound pipeline, confirming end-to-end delivery from the
provider's status webhook, using a bounded fallback route when the primary
route fails, and surfacing every miss as an actionable failure.

## How it works

A poller (`apps/api/src/jobs/alertDelivery.jobs.js`) runs in the **worker**
process on a configurable interval. Each tick:

1. **Reconcile** — any outstanding synthetic test is checked against its
   linked `Notification`'s provider delivery status. `delivered`/`read` ⇒ the
   test is confirmed end-to-end. Provider `failed` ⇒ the test fails. No
   confirmation within the acknowledgement timeout ⇒ the test times out and
   becomes an actionable failure.
2. **Missed-test detection** — if no successful end-to-end verification has
   happened for `interval × missedFactor` and no test is in flight (for example
   the scheduler stopped), overall health flips to `failed`/`missed_test`. A
   stopped scheduler can therefore never look healthy.
3. **Dispatch** — if enabled, not already in flight, not before the due time,
   and a test is not already running for this interval epoch, a new synthetic
   test is dispatched through every configured route.

The core logic lives in `apps/api/src/observability/alertDelivery.service.js`
and is fully unit-tested.

## Synthetic alerts

Each synthetic test:

- is dispatched to **only** `ALERT_TEST_RECIPIENT` — an internal operator
  WhatsApp number, never a customer;
- is clearly marked as synthetic via:
  - `biz_opaque_callback_data` / correlation id prefixed `synthetic-alert:`,
  - the linked `Notification` row with `type=synthetic_test` and
    `referenceType=alert-test`,
  - the message body `[SendAm alert-delivery test] …`;
- uses the **real** outbound pipeline (`whatsapp.service`), so it exercises the
  exact same path real alerts take.

### Customer paging is impossible

Synthetic tests never run the customer-facing responder (`assistant.service` /
`processMessage`), never touch user wallets, and are only ever sent to the
configured internal recipient. Because the recipient is a single operator value
(coupled to the hard kill switch), there is no route by which a synthetic alert
can reach a customer. The service refuses to dispatch when no recipient is
configured, and the tests assert the recipient invariant.

## Routes and fallback

Routes are the delivery variants a synthetic test can use, ordered so the
**primary** route is tried first:

| Order | Route | Delivery mechanism |
|-------|-------|--------------------|
| 1 (primary) | `whatsapp-text` | free-form `sendTextMessage` |
| 2 (fallback, only if `ALERT_TEST_TEMPLATE_NAME` is set) | `whatsapp-template` | approved `sendTemplateMessage` |

Because WhatsApp only allows free-form text inside an open 24-hour customer
window, the primary text route can fail (e.g. window expired) while the approved
template route still succeeds — exactly the real-world failure the fallback is
for.

```
Synthetic alert
      │
      ▼
Primary route (whatsapp-text)
      │
      ├── success ──────────────────► verified (healthy)
      │
      └── failure ──────────────────► fallback route (whatsapp-template)
                                           │
                                           ├── success ─► verified (degraded — primary failure kept visible)
                                           └── failure ─► verification failed
```

- The fallback is **bounded**: it is attempted at most once per test (ordered
  route list, no recursion).
- A primary failure is **never hidden**: the overall status becomes `degraded`
  (still an end-to-end success, but the primary route needs attention), and the
  run records each route's outcome.
- If both routes fail, the overall status becomes `failed` and the failure
  reason (`all_routes_failed_synchronously`) plus per-route detail are
  persisted.

## Confirmation boundary

The WhatsApp Cloud API returns a provider message id synchronously when it has
*accepted* a message, but actual delivery arrives later via the status webhook
(`sent` → `delivered` → `read`, or terminal `failed`). Consequently:

- **Synchronous acceptance** (`providerMessageId`) is *not* treated as
  end-to-end delivery. A test that is only accepted remains in the `accepted`
  state awaiting confirmation.
- **Confirmation** means the provider-reported status is `delivered` or `read`
  for the linked `Notification` — i.e. the message reached the recipient's
  device. (Apache/Meta `delivered` is the strongest signal the current provider
  exposes; "read" is not required, so the check never depends on read
  receipts.)
- If no confirmation arrives within `ALERT_DELIVERY_ACK_TIMEOUT_MS`, the test
  is marked `timed_out` and overall health is `failed`.

Per-test status lifecycle:
`dispatched` → `accepted` → `confirmed`, or `failed`, or `timed_out`.

## Health states

| State | Meaning |
|-------|---------|
| `healthy` | Last end-to-end verification succeeded on the primary route. |
| `degraded` | Last end-to-end verification succeeded but only after a fallback route (primary route failing). |
| `failed` | A test failed, an acknowledgement timed out, a test was missed (`missed_test`), or all routes are unavailable. |
| `unknown` | The feature is enabled but no verification has completed yet (or history is absent). |
| `disabled` | Not configured (no recipient / kill switch off / `sim` transport). |

A **failed** verification never overwrites the last successful verification
timestamp, so operators can always tell when alert delivery was last proven
working.

## Anti-storm & idempotency

- `testId` is **deterministic per interval epoch** and unique — duplicate or
  overlapping scheduler executions collide on the constraint, so at most one
  test per interval is ever created.
- Dispatch is additionally gated on an **in-flight** test and the persisted
  **last-dispatch timestamp**, so a recovering provider is never flooded.
- A single confirmation update is what advances a test to `confirmed`; late or
  out-of-order delivery callbacks cannot duplicate a test.

## Persistence

Two tables live in PostgreSQL (via Prisma, same store as everything else):

- `AlertDeliveryTest` — append-only history of each synthetic run (per-route
  outcomes, timestamps, failure reasons).
- `AlertDeliveryState` — the singleton operational summary: overall health,
  `lastSuccessfulTestAt`, last dispatch/failure, and diagnostic detail.

## Operators viewing the last successful test

Authenticated admin API:

```
GET /api/admin/alert-delivery
```

Returns `overallStatus`, `lastSuccessfulTestAt`, `lastTestId`,
`lastDispatchAt`, `lastFailureAt`, `lastFailureReason`, and the 10 most recent
tests (with per-route outcomes). Never returns the test recipient or any
secret. The overall status is also surfaced on the existing health view:

```
GET /api/admin/system-health   →  { "alertDelivery": "healthy" | "degraded" | "failed" | "unknown" | "disabled" }
```

## Metrics & alerts

Prometheus gauges (label-free, no PII):

- `sendam_alert_delivery_status` — `1` healthy, `0.5` degraded, `0` failed/unknown/disabled.
- `sendam_alert_delivery_last_success_timestamp_seconds` — last successful end-to-end verification.
- `sendam_alert_delivery_age_seconds` — seconds since last success (`-1` if never).
- `sendam_alert_delivery_checks_total` and `sendam_alert_delivery_outcomes_total{outcome}`.

Alert rules are included in `observability/prometheus-rules.yml`:
`SendAmAlertDeliveryFailed` (critical), `SendAmAlertDeliveryDegraded`
(warning), and `SendAmAlertDeliveryNeverVerified` (warning when enabled but
never successful for several hours).

Key structured log events: `synthetic_alert_started`, `synthetic_alert_dispatched`,
`synthetic_alert_route_failed`, `synthetic_alert_fallback_started`,
`synthetic_alert_fallback_succeeded`, `synthetic_alert_delivery_confirmed`,
`synthetic_alert_acknowledged`, `synthetic_alert_verification_failed`,
`synthetic_alert_verification_timed_out`, `synthetic_alert_verification_missed`,
`alert_delivery_poller_started` / `_stopped` / `_disabled`.

## Configuration

See `apps/api/.env.example`. All variables are optional; the feature is off
until enabled.

| Variable | Default | Meaning |
|----------|---------|---------|
| `ALERT_TEST_RECIPIENT` | — | **Internal** operator WhatsApp number the synthetic alerts are sent to. Setting this enables the feature. |
| `ALERT_DELIVERY_ENABLED` | on when recipient set | Hard kill switch (`false` disables). |
| `ALERT_DELIVERY_INTERVAL_MS` | `3600000` (1h) | How often to run the end-to-end test. |
| `ALERT_DELIVERY_ACK_TIMEOUT_MS` | `600000` (10m) | How long to await provider delivery confirmation before the test times out. Keep it below the interval. |
| `ALERT_DELIVERY_MISSED_FACTOR` | `3` | Intervals of silence before a stalled/missed verification becomes `failed`. |
| `ALERT_TEST_TEMPLATE_NAME` | — | Approved WhatsApp template used by the fallback route. Leaving it empty disables the fallback. |
| `ALERT_TEST_TEMPLATE_LANGUAGE` | `en` | Language code for the fallback template. |

Invalid values are rejected at startup by `config/validateEnv.js`.

> Note: end-to-end delivery confirmation requires the real `meta` transport.
> With `MESSAGE_TRANSPORT=sim` the feature is left disabled because there is no
> provider delivery webhook to confirm against.

## Troubleshooting

1. **`alertDelivery: "failed"`, `lastFailureReason: "all_routes_failed_synchronously"`**
   — both routes rejected the send. Check the WhatsApp token/phone id, message
   transport, and the per-route errors in `GET /api/admin/alert-delivery`.
2. **`acknowledgement_timeout`** — the provider accepted the message but no
   `delivered`/`read` webhook arrived within the timeout. Verify the webhook is
   configured and delivering status callbacks
   (`docs/PRODUCTION-WHATSAPP-WEBHOOK.md`), and that the test recipient has
   delivery receipts enabled.
3. **`missed_test`** — no verification ran for several intervals with nothing
   in flight. The worker/poller is likely stopped; confirm the worker process
   is running and `alert_delivery_poller_started` appears in its logs.
4. **`degraded`** — the primary text route is failing and fallback delivery is
   keeping verification alive. Investigate the primary route (e.g. 24h window,
   send policy) before the fallback itself fails.
5. **No metric / always `disabled`** — `ALERT_TEST_RECIPIENT` is unset,
   `ALERT_DELIVERY_ENABLED=false`, or `MESSAGE_TRANSPORT=sim`.