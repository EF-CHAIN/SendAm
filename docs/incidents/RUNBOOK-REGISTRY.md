# Incident Runbook Registry

> **Closes #227**
>
> Every critical alert must link to a tested runbook with an owner and a
> last-exercised date. This registry is the single source of truth for that
> mapping. Runbooks are exercised via tabletop drills (see
> `docs/incidents/drills/`) and the `last-exercised` column is updated after
> each drill.

## How to use this registry

1. When a critical alert fires, look up the alert name in the table below.
2. Open the linked runbook and follow it top-to-bottom.
3. After resolution, record the incident in a post-incident review under
   `docs/incidents/YYYY-MM-DD-<slug>.md`.
4. After any tabletop drill, update the `last-exercised` date for the affected
   runbook(s) and record follow-up actions in `docs/incidents/drills/`.

## Runbook registry

| Alert / Scenario | Severity | Runbook | Owner | Last exercised |
|------------------|----------|---------|-------|----------------|
| `SendAmApiDown` | P0 | [Payment Outage Response §4a](OPERATOR-RECOVERY-PLAYBOOK.md#4a-stellar-settlement-failures) | Engineering lead | 2026-08-29 |
| `SendAmWorkerDown` | P0 | [Queue Failure Response §7b](OPERATOR-RECOVERY-PLAYBOOK.md#7b-worker-process-not-running) | Engineering lead | 2026-08-29 |
| `SendAmWorkerNotReady` | P0 | [Queue Failure Response §7b](OPERATOR-RECOVERY-PLAYBOOK.md#7b-worker-process-not-running) | Engineering lead | 2026-08-29 |
| `SendAmWorkerHeartbeatStale` | P0 | [Queue Failure Response §7b](OPERATOR-RECOVERY-PLAYBOOK.md#7b-worker-process-not-running) | Engineering lead | 2026-08-29 |
| `SendAmQueueLagHigh` | P0 | [Queue Failure Response §7a](OPERATOR-RECOVERY-PLAYBOOK.md#7a-whatsapp-messages-not-processed) | Engineering lead | 2026-08-29 |
| `SendAmQueueStalled` | P2 | [Queue Failure Response §7a](OPERATOR-RECOVERY-PLAYBOOK.md#7a-whatsapp-messages-not-processed) | Engineering lead | 2026-08-29 |
| `SendAmDepositSweepStale` | P0 | [Payment Outage Response §4a](OPERATOR-RECOVERY-PLAYBOOK.md#4a-stellar-settlement-failures) | Payments lead | 2026-08-29 |
| `SendAmHighHttpErrorRate` | P0 | [Payment Outage Response §4b](OPERATOR-RECOVERY-PLAYBOOK.md#4b-high-failed-payment-rate) | Engineering lead | 2026-08-29 |
| `SendAmHighLatency` | P2 | [Payment Outage Response §4a](OPERATOR-RECOVERY-PLAYBOOK.md#4a-stellar-settlement-failures) | Engineering lead | 2026-08-29 |
| `SendAmUnhandledExceptions` | P0 | [Exception Spike §9](OPERATOR-RECOVERY-PLAYBOOK.md#9-rollback-criteria--procedures) | Engineering lead | 2026-08-29 |
| `SendAmQueueFailures` | P0 | [Queue Failure Response §7a](OPERATOR-RECOVERY-PLAYBOOK.md#7a-whatsapp-messages-not-processed) | Engineering lead | 2026-08-29 |
| `SendAmDatabaseHealthDegraded` | P0 | [Database Incident Response §6a](OPERATOR-RECOVERY-PLAYBOOK.md#6a-database-connection-lost) | Engineering lead | 2026-08-29 |
| `SendAmRedisDisconnected` | P0 | [Queue Failure Response §7a](OPERATOR-RECOVERY-PLAYBOOK.md#7a-whatsapp-messages-not-processed) | Engineering lead | 2026-08-29 |
| `SendAmRedisRetriesExhausted` | P0 | [Queue Failure Response §7a](OPERATOR-RECOVERY-PLAYBOOK.md#7a-whatsapp-messages-not-processed) | Engineering lead | 2026-08-29 |
| `SendAmQueueInlineFallback` | P0 | [Queue Failure Response §7a](OPERATOR-RECOVERY-PLAYBOOK.md#7a-whatsapp-messages-not-processed) | Engineering lead | 2026-08-29 |
| `SendAmCriticalDependencyDown` | P0 | [Provider Incident Response §8](OPERATOR-RECOVERY-PLAYBOOK.md#8-provider-incident-response) | Provider owner | 2026-08-29 |
| `SendAmImportantDependencyDown` | P2 | [Provider Incident Response §8](OPERATOR-RECOVERY-PLAYBOOK.md#8-provider-incident-response) | Provider owner | 2026-08-29 |
| `SendAmDependencyHealthMissing` | P2 | [Provider Incident Response §8](OPERATOR-RECOVERY-PLAYBOOK.md#8-provider-incident-response) | Provider owner | 2026-08-29 |
| Duplicate payment detected | P0 | [Duplicate Payment Response §4d](OPERATOR-RECOVERY-PLAYBOOK.md#4d-duplicate-payment-detected) | Payments lead | 2026-08-29 |
| Credential compromise suspected | P0 | [Credential Compromise Response §5d](OPERATOR-RECOVERY-PLAYBOOK.md#5d-credential-compromise-suspected) | Security lead | 2026-08-29 |
| Key material compromise / rotation | P0 | [Key Management Incident Response §13](OPERATOR-RECOVERY-PLAYBOOK.md#13-key-management-incident-response) | Security lead | 2026-08-29 |

## Critical alert → runbook coverage matrix

The following critical alerts are covered by a tested runbook:

| Alert | Runbook section | Owner | Last exercised |
|-------|----------------|-------|----------------|
| `SendAmApiDown` | §4a | Engineering lead | 2026-08-29 |
| `SendAmWorkerDown` | §7b | Engineering lead | 2026-08-29 |
| `SendAmWorkerNotReady` | §7b | Engineering lead | 2026-08-29 |
| `SendAmWorkerHeartbeatStale` | §7b | Engineering lead | 2026-08-29 |
| `SendAmQueueLagHigh` | §7a | Engineering lead | 2026-08-29 |
| `SendAmDepositSweepStale` | §4a | Payments lead | 2026-08-29 |
| `SendAmHighHttpErrorRate` | §4b | Engineering lead | 2026-08-29 |
| `SendAmUnhandledExceptions` | §9 | Engineering lead | 2026-08-29 |
| `SendAmQueueFailures` | §7a | Engineering lead | 2026-08-29 |
| `SendAmDatabaseHealthDegraded` | §6a | Engineering lead | 2026-08-29 |
| `SendAmRedisDisconnected` | §7a | Engineering lead | 2026-08-29 |
| `SendAmRedisRetriesExhausted` | §7a | Engineering lead | 2026-08-29 |
| `SendAmQueueInlineFallback` | §7a | Engineering lead | 2026-08-29 |
| `SendAmCriticalDependencyDown` | §8 | Provider owner | 2026-08-29 |

## Drill schedule

| Drill | Frequency | Owner | Last run | Next due |
|-------|-----------|-------|----------|----------|
| Payment outage tabletop | Quarterly | Payments lead | 2026-08-29 | 2026-11-29 |
| Key-management tabletop | Quarterly | Security lead | 2026-08-29 | 2026-11-29 |
| Database restore drill | Monthly (automated) | Engineering lead | 2026-08-29 | 2026-09-29 |
| Queue failure tabletop | Semi-annual | Engineering lead | 2026-08-29 | 2027-02-29 |
| Provider outage tabletop | Semi-annual | Provider owner | 2026-08-29 | 2027-02-29 |
| Credential compromise tabletop | Semi-annual | Security lead | 2026-08-29 | 2027-02-29 |

---

*Last updated: 2026-08-29. Policy version: runbook-registry-v1.*
