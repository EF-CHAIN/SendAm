# Tabletop Exercise: Payment Outage & Duplicate Payment

> **Closes #227** — Tabletop exercise record for the payment incident runbook.

- **Date:** 2026-08-29
- **Facilitator:** Engineering lead
- **Participants:** Payments lead, on-call engineer, compliance officer (observer)
- **Runbook exercised:** [Payment Outage Response §4](OPERATOR-RECOVERY-PLAYBOOK.md#4-payment-outage-response) and [Duplicate Payment Response §4d](OPERATOR-RECOVERY-PLAYBOOK.md#4d-duplicate-payment-detected)
- **Duration:** 60 minutes

## Scenario

A Stellar network outage causes transactions to remain in `pending` for over
30 minutes. During recovery, an operator retries a batch of stuck payments
without first reconciling idempotency keys, resulting in a duplicate payment
to one customer. Simultaneously, the deposit sweep alert fires.

## Exercise flow

1. **Detection (0–5 min):** On-call receives `SendAmDepositSweepStale` and
   `SendAmQueueLagHigh` alerts. Participants identify the affected runbook
   from the [runbook registry](../RUNBOOK-REGISTRY.md).
2. **Containment (5–15 min):** Participants walk through §4a steps 1–4:
   checking Stellar network status, Horizon connectivity, and stuck-payment
   tooling. They identify that retrying without reconciliation is the
   containment risk.
3. **Recovery (15–35 min):** Participants walk through §4d duplicate-payment
   steps: identifying the duplicate via `GET /api/admin/ledger/discrepancies`,
   freezing the affected transaction, and initiating a refund.
4. **Communication (35–45 min):** Participants draft the internal P0 alert
   and the user-facing WhatsApp broadcast using §10 templates.
5. **Post-incident (45–60 min):** Participants draft the post-incident review
   outline and assign follow-up actions.

## Findings

| # | Finding | Severity | Action |
|---|---------|----------|--------|
| 1 | The playbook §4a step 4 does not explicitly warn against retrying stuck payments before reconciling idempotency keys. | High | Add an explicit warning to §4a step 4: "Do not retry a batch of stuck payments until idempotency keys are reconciled — see §4d." |
| 2 | The duplicate-payment detection relies on `GET /api/admin/ledger/discrepancies`, but participants were unsure whether this endpoint surfaces duplicate `providerReference` values. | Medium | Verify the endpoint surfaces duplicate provider references; if not, add a dedicated duplicate-detection query. |
| 3 | The refund flow in §4a step 5 requires a `reason` field, but participants were unsure whether the refund is idempotent. | Medium | Confirm refund idempotency and document it in §4d. |
| 4 | The runbook registry did not list a dedicated duplicate-payment runbook at the time of the drill. | Low | Add the duplicate-payment scenario to the registry (done in this change). |

## Follow-up actions

| # | Action | Owner | Due date | Status |
|---|--------|-------|----------|--------|
| 1 | Add explicit idempotency-reconciliation warning to §4a step 4. | Engineering lead | 2026-09-05 | Open |
| 2 | Verify `GET /api/admin/ledger/discrepancies` surfaces duplicate provider references; add a dedicated query if needed. | Payments lead | 2026-09-12 | Open |
| 3 | Confirm refund idempotency and document it in §4d. | Payments lead | 2026-09-12 | Open |
| 4 | Add duplicate-payment scenario to the runbook registry. | Engineering lead | 2026-09-05 | Done |

## Sign-off

- Facilitator: Engineering lead
- Payments lead
- On-call engineer

---

*Recorded: 2026-08-29. Next drill due: 2026-11-29.*
