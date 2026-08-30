# Operator Recovery Playbook

> **Closes #322, #227**
>
> This runbook covers the most common production failure modes for SendAm.
> Operators should follow each section top-to-bottom. All recovery actions
> must be attributed in the audit log (`admin.incident.*` events) and
> reviewed in a post-incident write-up within 48 hours of resolution.
>
> Every critical alert links to a tested runbook with an owner and a
> last-exercised date — see the [Runbook Registry](incidents/RUNBOOK-REGISTRY.md)
> and the tabletop drill records under `docs/incidents/drills/`.

---

## Table of Contents

1. [Incident Severity Levels](#1-incident-severity-levels)
2. [Escalation Chain & Ownership](#2-escalation-chain--ownership)
3. [Wallet Incident Response](#3-wallet-incident-response)
4. [Payment Outage Response](#4-payment-outage-response)
5. [Auth Incident Response](#5-auth-incident-response)
6. [Database Incident Response](#6-database-incident-response)
7. [Webhook / Queue Failure Response](#7-webhook--queue-failure-response)
8. [KYC / Compliance Incident Response](#8-kyc--compliance-incident-response)
9. [Rollback Criteria & Procedures](#9-rollback-criteria--procedures)
10. [Communication Templates](#10-communication-templates)
11. [Post-Incident Review](#11-post-incident-review)
12. [Drill & Update Schedule](#12-drill--update-schedule)
13. [Key Management Incident Response](#13-key-management-incident-response)
14. [Runbook Registry](#14-runbook-registry)

---

## 1. Incident Severity Levels

| Level | Description | Response SLO |
|-------|-------------|--------------|
| **P0** | Money loss, data breach, complete service outage, compromised key material | Immediate — page on-call now |
| **P1** | Payments failing for >10% of users, auth broken, DB unreachable | < 15 minutes |
| **P2** | Degraded payment success rate, KYC callback failures, queue lag | < 1 hour |
| **P3** | Single-user issues, non-critical feature degraded | Next business day |

---

## 2. Escalation Chain & Ownership

```
On-call engineer  →  Engineering lead  →  CTO / Head of Product
                   ↓
              Compliance officer (if KYC / AML / data breach involved)
                   ↓
              Legal counsel (if P0 breach or regulatory notification required)
```

**Sign-off required before closing a P0/P1:**
- Engineering lead
- Compliance officer (if financial data impacted)

---

## 3. Wallet Incident Response

### 3a. Wallet creation failures

**Symptoms:** `POST /api/wallet/create` returning 5xx; users cannot onboard.

**Steps:**
1. Check `GET /api/admin/system-health` — confirm `database: ok`.
2. Look for `wallet_creation_failed` in application logs:
   ```bash
   grep 'wallet_creation_failed' <log-stream>
   ```
3. Verify `ENCRYPTION_KEY` is set and unchanged. A rotation without migration
   leaves existing encrypted keys unreadable — **do not rotate mid-incident**.
4. If the issue is a DB constraint error (`P2002`), a duplicate wallet row
   exists. Query `Wallet` for `userId + chain` uniqueness before retrying.
5. If the Stellar SDK call fails (`stellar_create_account_failed`), confirm the
   funding source account has XLM to cover the minimum reserve + fees.
   - Testnet: use Friendbot (`https://friendbot.stellar.org?addr=<key>`).
   - Mainnet: top up the platform funding key from cold storage.
6. Record recovery action in audit log:
   ```
   action: admin.incident.wallet_creation_recovered
   ```

### 3b. Encrypted key unreadable / decryption failure

**Symptoms:** `crypto_decrypt_failed` log events; payments fail with 500.

> ⚠️ **P0 — treat as potential key compromise until confirmed otherwise.**

**Steps:**
1. **Do not** attempt to rotate `ENCRYPTION_KEY` until the root cause is known.
2. Page engineering lead and compliance immediately.
3. Identify affected wallets:
   ```sql
   SELECT id, userId, chain, keyVersion, createdAt
   FROM "Wallet"
   WHERE "encryptedSecretKey" IS NOT NULL;
   ```
4. Check whether `ENCRYPTION_KEY` env var matches the version (`keyVersion`)
   stored on the wallet rows.
5. If a key rotation was recently deployed, run the key rotation migration
   script to re-encrypt under the new key:
   ```bash
   node apps/api/scripts/rotate-wallet-keys.js --dry-run
   node apps/api/scripts/rotate-wallet-keys.js
   ```
6. If keys are genuinely lost (no backup), escalate to CTO immediately —
   funds may require Stellar multisig recovery.

### 3c. Missing USDC trustline

**Symptoms:** `trustline_missing` errors; users cannot receive USDC.

**Steps:**
1. Identify wallets with `trustlineState != 'complete'`:
   ```
   GET /api/admin/wallets?fundingState=funded
   ```
   Filter client-side for `trustlineState != 'complete'`.
2. The deposit poller auto-establishes trustlines on new wallets. If it is
   stalled, check the deposit worker process is running.
3. For stuck wallets, the trustline establishment can be triggered by
   restarting the worker or running a manual backfill:
   ```bash
   node apps/api/scripts/audit-and-reconcile-monetary.js
   ```

---

## 4. Payment Outage Response

### 4a. Stellar settlement failures

**Symptoms:** Transactions stuck in `pending`/`processing`; `stellar_submit_failed` logs.

**Steps:**
1. Check Stellar network status: https://dashboard.stellar.org
2. Check Horizon endpoint connectivity from the API host:
   ```bash
   curl https://horizon.stellar.org/
   ```
3. If Horizon is unavailable, payments will queue and retry automatically once
   connectivity is restored (BullMQ with exponential backoff).
4. If transactions are stuck > 30 min, use the stuck-payment tooling:
   ```
   GET /api/admin/payments/stuck
   POST /api/admin/payments/stuck/:id/retry
   POST /api/admin/payments/stuck/:id/resolve   (mark as needing refund)
   ```
5. For a confirmed failed settlement, trigger a refund:
   ```
   POST /api/admin/transactions/:id/refund
   Body: { "reason": "Stellar network outage — operator-initiated refund" }
   ```
6. Log the incident:
   ```
   action: admin.incident.payment_outage_resolved
   ```

### 4b. High failed-payment rate

**Symptoms:** Dashboard shows >10% `failed` transactions; users reporting lost funds.

**Steps:**
1. Check `GET /api/admin/stats` for the failed/pending ratio.
2. Check `GET /api/admin/ledger/discrepancies` for imbalance.
3. Run reconciliation:
   ```
   POST /api/admin/reconciliation/trigger
   GET  /api/admin/reconciliation/checkpoints
   ```
4. For each unresolved checkpoint:
   ```
   PATCH /api/admin/reconciliation/checkpoints/:id/resolve
   Body: { "resolution": "manual_review", "notes": "..." }
   ```
5. Notify affected users via WhatsApp if their funds are at risk — use the
   notification system (do not send manual messages).

### 4c. Rate-limit false positives

**Symptoms:** Legitimate users getting 429 from `/webhook`.

**Steps:**
1. Check `RateLimitHit` table for the affected sender's key.
2. Clear the key if confirmed false positive:
   ```sql
   DELETE FROM "RateLimitHit" WHERE key = 'whatsapp:<phone>';
   ```
3. Review the rate-limit configuration in `src/services/rateLimit.service.js`
   and adjust thresholds in env if warranted.

### 4d. Duplicate payment detected

**Symptoms:** A customer reports being charged twice; `GET /api/admin/ledger/discrepancies` shows an imbalance; two transactions share the same `providerReference`.

> ⚠️ **P0 — treat as potential money loss until confirmed otherwise.**

**Steps:**
1. **Contain immediately** — do not retry any stuck payments until
   idempotency keys are reconciled. Retrying a batch without reconciliation
   is the most common cause of duplicate payments.
2. Identify the duplicate via the ledger discrepancies endpoint:
   ```
   GET /api/admin/ledger/discrepancies
   ```
   Look for two transactions sharing the same `providerReference` or
   `idempotencyKey`.
3. Freeze the affected transaction(s) to prevent further settlement:
   ```
   POST /api/admin/transactions/:id/freeze
   Body: { "reason": "Duplicate payment detected — operator hold" }
   ```
4. Confirm which transaction is the legitimate one by checking the
   `providerReference` against the Stellar ledger (Horizon) and the original
   customer intent.
5. Initiate a refund for the duplicate:
   ```
   POST /api/admin/transactions/:id/refund
   Body: { "reason": "Duplicate payment — operator-initiated refund" }
   ```
6. Notify the affected customer via WhatsApp using the notification system
   (do not send manual messages). Use the §10 user-facing template.
7. Record the incident:
   ```
   action: admin.incident.duplicate_payment_resolved
   ```
8. Review the root cause — typically a retry without idempotency-key
   reconciliation. Confirm the retry path in §4a step 4 is followed.

---

## 5. Auth Incident Response

### 5a. Admin login failures / locked out

**Symptoms:** All admin logins return 401; operators cannot access the dashboard.

**Steps:**
1. Verify `ADMIN_PASSWORD` and `JWT_SECRET` env vars are set on the API host.
2. Check `AdminUser` table for enabled accounts:
   ```
   GET /api/admin/administrators   (requires a valid token)
   ```
   If you have no valid token, use a database query:
   ```sql
   SELECT id, email, "disabledAt", "mustChangePassword"
   FROM "AdminUser"
   WHERE "disabledAt" IS NULL;
   ```
3. If `mustChangePassword = true`, the operator must POST `/api/admin/password`
   with a temporary credential before accessing other endpoints.
4. If all admin accounts are disabled, re-enable the bootstrap account via
   direct DB update (document the reason in the post-incident):
   ```sql
   UPDATE "AdminUser" SET "disabledAt" = NULL WHERE email = '<bootstrap-email>';
   ```
5. Immediately rotate credentials after restoring access.

### 5b. Suspected session token compromise

**Symptoms:** Unusual admin activity in audit logs; operator reports account used without their knowledge.

> ⚠️ Treat as P0 if financial admin actions were taken.

**Steps:**
1. Immediately revoke all sessions for the affected admin:
   ```
   POST /api/admin/administrators/:id/revoke-sessions
   ```
2. Disable the account:
   ```
   POST /api/admin/administrators/:id/disable
   ```
3. Review audit logs for the compromised session:
   ```
   GET /api/admin/audit-logs?actorId=<admin-id>
   ```
4. Export audit logs for legal evidence if needed:
   ```
   GET /api/admin/audit-logs/export
   ```
5. Notify compliance and, if financial data was accessed or modified,
   initiate regulatory notification review.

### 5c. WhatsApp signature verification failures spike

**Symptoms:** High rate of 403 on `POST /webhook`; `whatsapp_signature_invalid` logs.

**Steps:**
1. Confirm `WHATSAPP_APP_SECRET` is correct and matches the Meta app setting.
2. Check for clock skew — signature timestamps must be within the tolerance
   window (`WHATSAPP_SIGNATURE_TOLERANCE_MS`, default 300 s).
3. If Meta rotated the app secret, update `WHATSAPP_APP_SECRET` in the
   deployment environment and restart the API.
4. Do **not** disable signature verification to restore service — this would
   open the webhook to unauthenticated payloads.

### 5d. Credential compromise suspected

**Symptoms:** Unusual activity in audit logs; service-account or API-key
credentials used without authorization; `ADMIN_PASSWORD`, `JWT_SECRET`, or a
provider secret suspected of exposure.

> ⚠️ **P0 — treat as potential data breach until confirmed otherwise.**

**Steps:**
1. **Contain immediately** — revoke all sessions for the affected account:
   ```
   POST /api/admin/administrators/:id/revoke-sessions
   ```
2. Disable the affected account(s):
   ```
   POST /api/admin/administrators/:id/disable
   ```
3. For service accounts or API keys, rotate the credential immediately:
   - `ADMIN_PASSWORD`: update the env var and restart the API.
   - `JWT_SECRET`: rotate and restart the API — all sessions will be invalidated.
   - `WHATSAPP_APP_SECRET`: update in the Meta dashboard and the deployment env.
   - `ENCRYPTION_KEY`: **do not rotate mid-incident** — see §13.
4. Review audit logs for the compromised credential:
   ```
   GET /api/admin/audit-logs?actorId=<admin-id>
   ```
   Or, for service accounts, search application logs for the affected key.
5. Export audit logs for legal evidence if needed:
   ```
   GET /api/admin/audit-logs/export
   ```
6. Notify compliance and, if financial data was accessed or modified,
   initiate regulatory notification review using the §10 template.
7. Record the incident:
   ```
   action: admin.incident.credential_compromise_resolved
   ```

---

## 6. Database Incident Response

### 6a. Database connection lost

**Symptoms:** `GET /health` returns 503; all DB-backed endpoints fail.

**Steps:**
1. Confirm DB connectivity from the API host:
   ```bash
   psql "$DATABASE_URL" -c "SELECT 1;"
   ```
2. Check the database provider status page (Neon, RDS, etc.).
3. If connection pooling is exhausted, restart the API process — Prisma will
   re-establish the pool on start.
4. If using Neon, check for autoscaling cold-start delays (first query on a
   cold branch can take 2–5 s).
5. Never override `DATABASE_URL` to a different database to restore service —
   this risks running against stale or test data.

### 6b. Migration failure in production

**Symptoms:** API fails to start after a deploy; Prisma migration error in logs.

**Steps:**
1. Do **not** run `prisma migrate reset` in production — this drops all data.
2. Check the migration state:
   ```bash
   npm run prisma:studio --workspace=apps/api
   ```
   Or query directly:
   ```sql
   SELECT * FROM "_prisma_migrations" ORDER BY "started_at" DESC LIMIT 10;
   ```
3. If a migration is marked `failed`, resolve it manually using
   `prisma migrate resolve`:
   ```bash
   npx prisma migrate resolve --applied <migration-name> --schema apps/api/prisma/schema.prisma
   ```
4. Rollback the deploy to the last known-good version while the migration
   issue is investigated.

---

## 7. Webhook / Queue Failure Response

### 7a. WhatsApp messages not processed

**Symptoms:** Users send messages but get no response; `webhook_queue_enqueue_failed` logs.

**Steps:**
1. Check Redis / Upstash connectivity:
   ```bash
   redis-cli -u "$REDIS_URL" PING
   ```
2. Inspect the BullMQ dead-letter queue (DLQ):
   ```bash
   node apps/api/scripts/whatsapp-dlq.js --list
   ```
3. Replay DLQ jobs after fixing the root cause:
   ```bash
   node apps/api/scripts/whatsapp-dlq.js --replay
   ```
4. If Redis is unavailable, the webhook acknowledges Meta immediately but
   drops message processing. Messages lost during this window will not be
   retried — notify affected users manually if the outage was > 5 minutes.

### 7b. Worker process not running

**Symptoms:** Jobs enqueue but never process; `worker_not_running` alerts.

**Steps:**
1. Verify the worker process is running on the worker host:
   ```bash
   ps aux | grep worker
   ```
2. Restart the worker:
   ```bash
   npm run worker --workspace=apps/api
   ```
3. If the worker crashes immediately, check for missing env vars —
   the worker requires the same env as the API.
4. Check for poison-pill jobs (jobs that crash the worker on every attempt):
   ```bash
   node apps/api/scripts/whatsapp-dlq.js --list-failed
   ```
   Move them to the DLQ manually:
   ```bash
   node apps/api/scripts/whatsapp-dlq.js --mark-failed <job-id>
   ```

---

## 8. KYC / Compliance Incident Response

### 8a. KYC callback not received from Smile ID

**Symptoms:** Users start KYC but remain in `pending`; no callbacks arriving.

**Steps:**
1. Verify the callback URL is correctly configured in the Smile ID dashboard:
   `https://<api-host>/api/compliance/kyc/callback/smileid`
2. Confirm `SMILE_ID_CALLBACK_URL` env var matches.
3. Check `KycWebhookEvent` for recent entries — if empty, callbacks are not
   arriving.
4. For stuck profiles, manually review and advance via the admin API:
   ```
   POST /api/compliance/kyc/:id/review
   Body: { "status": "review", "reason": "Callback not received — manual review" }
   ```
5. Escalate to Smile ID support with the `job_id` (stored as
   `providerReference` on `KycProfile`).

### 8b. Sanctions screening unavailable

**Symptoms:** `sanctions_screening_failed` logs; transactions requiring screening are blocked.

**Steps:**
1. The system uses a cached result for up to 72 hours (`COMPLIANCE_SCREENING_MAX_STALENESS_MS`).
   Check the `lastScreenedAt` field on affected profiles.
2. If the configured screening provider is down, switch to the static fallback
   for emergency continuity:
   ```
   COMPLIANCE_SCREENING_PROVIDER=static
   ```
   Then restart the API. **Document this as a compliance exception** in the
   audit log and restore the live provider as soon as possible.
3. Review all transactions processed during the outage for manual sanctions
   check before allowing settlement.

### 8c. Verification expiry escalations not expected

**Symptoms:** Users unexpectedly moved to `review` status; `verification.escalation.enforced` in audit logs.

**Steps:**
1. Review the escalation audit log entries:
   ```
   GET /api/admin/audit-logs?action=verification.escalation.enforced
   ```
2. Check expiry policy settings:
   ```
   GET /api/admin/compliance/expiry-summary
   ```
3. If policy thresholds need adjustment, update env vars:
   ```
   COMPLIANCE_KYC_STALE_DAYS=<days>
   COMPLIANCE_KYC_ESCALATION_DAYS=<days>
   COMPLIANCE_SANCTION_EXPIRY_DAYS=<days>
   ```
4. For incorrectly escalated users, re-approve via the KYC review endpoint:
   ```
   POST /api/compliance/kyc/:id/review
   Body: { "status": "approved", "reason": "False escalation — operator reinstated" }
   ```

---

## 9. Rollback Criteria & Procedures

### When to rollback

Rollback a deployment immediately if **any** of the following are true within
15 minutes of the deploy:

- Error rate on `POST /webhook` exceeds 5% (baseline: <0.5%)
- `GET /health` returns 503
- Any `crypto_decrypt_failed` events appear in logs
- Any successful transaction count drops to zero
- Audit log chain breaks detected (`admin.audit.verify` fails)

### How to rollback

**Railway / Render:**
1. Navigate to the service deployment history.
2. Select the previous successful deployment.
3. Click "Redeploy" or "Rollback".
4. Confirm `GET /health` returns 200 after rollback.

**Manual (VM / Docker):**
```bash
# Tag the current bad image
docker tag sendam-api:current sendam-api:rollback-candidate-$(date +%Y%m%d%H%M)

# Deploy the previous known-good image
docker pull sendam-api:<previous-tag>
docker stop sendam-api && docker run -d --name sendam-api sendam-api:<previous-tag>
```

**Database rollbacks** are only done for additive migrations (new columns/tables).
Destructive migration rollbacks require a full restore from backup — see
`docs/PRODUCTION-DATABASE.md`.

---

## 10. Communication Templates

### Internal P0 alert
```
[P0 INCIDENT] SendAm production issue
Time detected: <ISO timestamp>
Symptoms: <brief description>
Impact: <who is affected and how>
On-call: <name>
Status channel: #incidents
```

### User-facing outage message (WhatsApp broadcast — use sparingly)
```
Hi {name} — we're aware of a temporary issue affecting SendAm payments.
Our team is working to resolve it. Your funds are safe. We'll message
you once everything is back to normal. Sorry for the disruption.
```

### Regulatory notification template (consult legal before sending)
```
To: <regulator contact>
Subject: Incident notification — SendAm / EF-CHAIN

We are writing to notify you of an incident affecting our payment service
on <date>. The incident was detected at <time>, and resolution was
confirmed at <time>. [Describe impact, affected users, financial amounts
if any, root cause, and remediation steps.] We are available to provide
further information on request.
```

---

## 11. Post-Incident Review

Every P0 and P1 requires a written post-incident review within **48 hours**
of resolution. The review must cover:

1. **Timeline** — detection time, response time, resolution time.
2. **Root cause** — technical and process root cause.
3. **Impact** — affected users, transactions, duration.
4. **Resolution** — steps taken to restore service.
5. **Action items** — concrete follow-up tasks with owner and due date.
6. **Audit verification** — confirm `admin.incident.*` events appear in the
   audit trail and pass integrity check.

Post-incident reviews are stored in `docs/incidents/YYYY-MM-DD-<slug>.md`.

---

## 12. Drill & Update Schedule

| Activity | Frequency | Owner | Last run |
|----------|-----------|-------|----------|
| Walkthrough of this runbook | Quarterly | Engineering lead | 2026-08-29 |
| Restore drill (DB backup restore) | Monthly (automated via CI) | Engineering lead | 2026-08-29 |
| KYC escalation drill | Semi-annual | Compliance officer | 2026-08-29 |
| Auth compromise drill | Semi-annual | Security lead | 2026-08-29 |
| Payment outage tabletop | Quarterly | Payments lead | 2026-08-29 |
| Key-management tabletop | Quarterly | Security lead | 2026-08-29 |
| Queue failure tabletop | Semi-annual | Engineering lead | 2026-08-29 |
| Provider outage tabletop | Semi-annual | Provider owner | 2026-08-29 |
| Credential compromise tabletop | Semi-annual | Security lead | 2026-08-29 |
| Runbook review & update | After every P0/P1 | Incident owner | — |

Drill results are recorded in `docs/incidents/drills/` and reviewed at the
next engineering all-hands.

---

## 13. Key Management Incident Response

### 13a. Key material compromise suspected

**Symptoms:** `crypto_decrypt_failed` events; `ENCRYPTION_KEY`, `JWT_SECRET`,
`WHATSAPP_APP_SECRET`, or `ADMIN_PASSWORD` suspected of exposure; unusual
decryption or signing activity in logs.

> ⚠️ **P0 — treat as potential key compromise until confirmed otherwise.**

**Steps:**
1. **Do not** rotate `ENCRYPTION_KEY` until the root cause is known — a
   rotation without migration leaves existing encrypted keys unreadable.
2. Page engineering lead and compliance immediately.
3. Identify affected wallets and their `keyVersion`:
   ```sql
   SELECT id, userId, chain, keyVersion, createdAt
   FROM "Wallet"
   WHERE "encryptedSecretKey" IS NOT NULL;
   ```
4. Check whether `ENCRYPTION_KEY` env var matches the `keyVersion` stored on
   the wallet rows.
5. If a key rotation was recently deployed, run the key rotation migration
   script to re-encrypt under the new key:
   ```bash
   node apps/api/scripts/rotate-wallet-keys.js --dry-run
   node apps/api/scripts/rotate-wallet-keys.js
   ```
6. If keys are genuinely lost (no backup), escalate to CTO immediately —
   funds may require Stellar multisig recovery.
7. For non-wallet key material (`JWT_SECRET`, `WHATSAPP_APP_SECRET`,
   `ADMIN_PASSWORD`), rotate the credential and restart the API. See §5d.
8. Record the incident:
   ```
   action: admin.incident.key_compromise_resolved
   ```

### 13b. Key rotation without migration

**Symptoms:** After a deploy, `crypto_decrypt_failed` events spike; payments
fail with 500; wallet rows reference a `keyVersion` that no longer matches
`ENCRYPTION_KEY`.

**Steps:**
1. Confirm the `keyVersion` on wallet rows vs. the current `ENCRYPTION_KEY`.
2. If a rotation was deployed without running the migration, run the rotation
   script to re-encrypt under the new key:
   ```bash
   node apps/api/scripts/rotate-wallet-keys.js --dry-run
   node apps/api/scripts/rotate-wallet-keys.js
   ```
3. If the migration script is unavailable or fails, roll back the deploy to
   the previous `ENCRYPTION_KEY` value (see §9) and re-run the migration
   offline.
4. Verify decryption succeeds on a sample of wallets before resuming
   financial traffic.

### 13c. Provider API key rotation

**Symptoms:** Provider calls fail with 401/403; `provider_auth_failed` logs.

**Steps:**
1. Identify the affected provider (Stellar, Smile ID, WhatsApp/Meta, etc.).
2. Check the provider dashboard for key rotation or expiry notices.
3. Update the corresponding env var (`STELLAR_*`, `SMILE_ID_*`,
   `WHATSAPP_APP_SECRET`, etc.) and restart the API.
4. Verify a test call succeeds before resuming traffic.
5. Record the incident:
   ```
   action: admin.incident.provider_key_rotated
   ```

---

## 14. Runbook Registry

Every critical alert links to a tested runbook with an owner and a
last-exercised date. The registry is maintained at
[`docs/incidents/RUNBOOK-REGISTRY.md`](incidents/RUNBOOK-REGISTRY.md).

Tabletop drill records are stored under `docs/incidents/drills/` and are
reviewed at the next engineering all-hands. After each drill, update the
`last-exercised` date in the registry and record follow-up actions in the
drill record.

---

*Last reviewed: 2026-08-29. Policy version: ops-runbook-v2.*
