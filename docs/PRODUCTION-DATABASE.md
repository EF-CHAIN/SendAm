# Production PostgreSQL runbook

SendAm supports a managed PostgreSQL service such as Neon through
`DATABASE_URL`, or a self-hosted PostgreSQL 16 instance provisioned by
`docker-compose.production.yml`. A managed service with automated point-in-time
recovery, multi-zone availability, TLS, and provider monitoring is preferred.

## Configuration

The API receives one secret:

```text
DATABASE_URL=postgresql://USER:PASSWORD@HOST/sendam?sslmode=require
DATABASE_CA="-----BEGIN CERTIFICATE-----...-----END CERTIFICATE-----"
DATABASE_POOL_MAX=10
DATABASE_CONNECTION_TIMEOUT_MS=5000
DATABASE_POOL_TIMEOUT_MS=10000
```

Production connections to non-local hosts must set `sslmode=require`,
`verify-ca`, or `verify-full`. Use separate least-privilege runtime and migration
roles when the provider supports them: the migration role owns the schema, while
the runtime role receives only the CRUD permissions required by the API. Never
commit either URL.

`DATABASE_CA` is an optional trusted CA bundle supplied by the secret manager;
certificate rotation updates that secret before restarting the process. Set
`REDIS_CA` the same way for a private Redis CA bundle. Do not set
`NODE_TLS_REJECT_UNAUTHORIZED=0` or equivalent global TLS bypasses.
The API defaults to a pool maximum of 10 and workers to 5. Set
`PROCESS_TYPE=worker` for worker processes. Reserve at least 10 connections for
migrations and emergency access, and ensure `API_INSTANCES * 10 + WORKER_INSTANCES * 5`
plus that reserve stays below PostgreSQL `max_connections`. Pool saturation,
waiting clients, and pool errors are exposed through `/metrics`.

For self-hosting, copy `deploy/postgres.env.example` to a root-level `.env`,
replace the password with a long random secret, restrict the file to the
deployment user, and run:

```bash
docker compose --env-file .env -f docker-compose.production.yml config
docker compose --env-file .env -f docker-compose.production.yml up -d postgres
docker compose --env-file .env -f docker-compose.production.yml ps
```

The production Compose definition does not publish PostgreSQL to the host. The
API must share the private `sendam-production_database` network or connect
through a separately secured private endpoint. The named data and backup
volumes must be included in host backup policy.

## Rollout

1. Provision the database, enable provider backups/PITR, and record the restore
   procedure and retention period.
2. Take a pre-migration snapshot of an existing installation.
3. Run `npm ci` and `npm run prisma:generate --workspace=apps/api`.
4. From a trusted migration runner with `DATABASE_URL`, run
   `npm run db:provision --workspace=apps/api`. This applies forward-only Prisma
   migrations and then checks connectivity, migration history, failed or pending
   migrations, PostgreSQL version, and required tables.
   Alternatively, configure `PRODUCTION_DATABASE_URL` in the protected GitHub
   `production` environment and manually run the **Provision production
   database** workflow with the required confirmation phrase. The workflow is
   serialized so two production migrations cannot run concurrently.
5. Deploy the API only after the validator emits
   `{"event":"database_validation_passed",...}`.
6. Exercise `/health` and a read/write smoke test, then watch database and API
   telemetry for at least one normal traffic window.

CI independently applies the migrations to an empty PostgreSQL 16 database and
to a simulated existing installation containing a sentinel user. It verifies
the sentinel survives the forward migration and verifies that an unreachable
database is rejected.

## Monitoring

## Orchestrator probes

Configure the API process with `HEALTH_CHECK_TIMEOUT_MS=1000` and use these
HTTP probes:

| Probe | Endpoint | Initial delay | Period | Timeout | Failure threshold |
| --- | --- | ---: | ---: | ---: | ---: |
| Startup | `/health/startup` | 10s | 5s | 2s | 12 |
| Liveness | `/health/live` | 30s | 10s | 2s | 3 |
| Readiness | `/health/ready` | 5s | 5s | 2s | 3 |

Startup remains unsuccessful until the API has connected to its required
startup resources. Liveness does not contact PostgreSQL or Redis. Readiness
requires both dependencies and returns `503` on a bounded timeout. Keep the
termination grace period longer than the worker shutdown timeout so active jobs
can retain their locks while draining.

Alert on:

- API `/health` reporting `db: disconnected`;
- `database_validation_failed` from release jobs;
- PostgreSQL availability, storage above 80%, connection use above 80% of
  `max_connections`, replication lag, backup failure, and sustained slow-query
  volume;
- any unfinished or rolled-back row in `_prisma_migrations`.

The self-hosted definition logs connections and statements slower than one
second by default. Send PostgreSQL container logs and API health checks to the
production log/alert platform. Platform Engineering owns provisioning,
credentials, backups, migrations, and recovery; application owners approve
schema changes and validate application behavior.

## Rollback and recovery

Prisma production migrations are forward-only. Do not run `migrate reset`,
`db push`, or manually delete `_prisma_migrations` rows in production.

If application deployment fails but the migration succeeds, roll back the
application image while leaving additive schema changes in place. For an
incompatible migration, stop writers, restore the pre-migration snapshot into a
new database, run `db:validate` against it, switch `DATABASE_URL`, and then
resume traffic. Never overwrite the failed database until reconciliation is
complete.

If a migration is interrupted, stop the release and application writers,
inspect PostgreSQL and `_prisma_migrations`, take a snapshot, and follow
Prisma's `migrate resolve` procedure only after identifying whether the SQL was
applied. Re-run `db:provision` and application smoke tests before reopening
traffic.

Test restores regularly: provision an isolated PostgreSQL instance from the
latest backup, run `db:provision`, run `db:validate`, and verify representative
user and transaction counts against the source.

## Automated restore verification and disaster-recovery drills

Platform Engineering owns PostgreSQL backup configuration, restore tooling, and
quarterly disaster-recovery evidence. The Payments owner provides encrypted
wallet validation approval, and Backend owners confirm that application-level
schema and representative data checks still match release behavior.

Recovery objectives for production data are:

- **PostgreSQL RPO:** latest restorable backup or PITR point must be no older
  than 24 hours; the workflow fails stale backups via
  `RESTORE_DRILL_MAX_BACKUP_AGE_MINUTES`.
- **PostgreSQL RTO:** an isolated restore, migration validation, data integrity
  checks, wallet decryptability sampling, evidence capture, and teardown must
  complete within 60 minutes via `RESTORE_DRILL_RTO_OBJECTIVE_MINUTES`.
- **Evidence retention:** retain the GitHub Actions log, redacted JSON result,
  backup ID, backup completion timestamp, measured RPO/RTO, incident commander,
  approvers, and teardown confirmation for 13 months in the incident evidence
  store. Do not store customer rows, wallet ciphertexts, plaintext keys, phone
  numbers, or Redis payloads in evidence.

The **Verify restore drill** workflow (`.github/workflows/verify-restore-drill.yml`)
runs weekly and can be started manually with the `VERIFY_RESTORE` confirmation.
It must target the protected `disaster-recovery-drill` environment, never
production. Configure these environment secrets and variables:

| Name | Type | Purpose |
| --- | --- | --- |
| `RESTORE_DRILL_COMMAND` | secret | Provider-specific command that restores the latest production backup into the isolated drill database only. |
| `RESTORE_DRILL_DATABASE_URL` | secret | PostgreSQL URL for the isolated restore target; it is passed as `DRILL_DATABASE_URL`. |
| `RESTORE_DRILL_ENCRYPTION_KEY` | secret | Approved recovery key material used only to decrypt sampled wallet records during the drill. |
| `RESTORE_DRILL_REDIS_URL` | secret | Optional isolated Redis restore target for BullMQ queue-state checks. |
| `RESTORE_DRILL_TEARDOWN_COMMAND` | secret | Provider-specific teardown for the drill database and Redis target; runs even after validation failure. |
| `RESTORE_DRILL_ALERT_WEBHOOK_URL` | secret | Optional alert webhook for failed drills or stale backups. |
| `LATEST_BACKUP_ID` | variable | Provider backup identifier recorded in evidence. |
| `LATEST_BACKUP_COMPLETED_AT` | variable | ISO-8601 completion timestamp for the latest backup. |
| `BACKUP_METADATA_JSON` | variable | Optional JSON override with `backupId` and `completedAt` fields. |
| `RESTORE_DRILL_MAX_BACKUP_AGE_MINUTES` | variable | RPO threshold; default is 1440 minutes. |
| `RESTORE_DRILL_RTO_OBJECTIVE_MINUTES` | variable | RTO threshold; default is 60 minutes. |

The workflow restores the backup, runs `npm run db:verify-restore
--workspace=apps/api`, and tears the target down. The verification script reuses
production schema validation, counts representative `User`, `Wallet`, and
`Transaction` rows without printing row contents, decrypts up to five wallet
records through `ENCRYPTION_KEY`, validates optional Redis queue metadata, and
emits only redacted JSON evidence.

End-to-end drill procedure:

1. Open an incident or scheduled-change ticket and assign a Platform Engineering
   incident commander. Confirm Payments has approved temporary key access.
2. Verify the target database and Redis names contain `drill` or another
   non-production marker. Confirm no production service uses the target URLs.
3. Update `LATEST_BACKUP_ID` and `LATEST_BACKUP_COMPLETED_AT` from the backup
   provider, or set `BACKUP_METADATA_JSON` if the provider exports metadata.
4. Start **Verify restore drill** with `VERIFY_RESTORE`, or monitor the weekly
   scheduled run.
5. Confirm the run records `restore_drill_passed`, measured `rpoMinutes`,
   measured `rtoMinutes`, migration count, representative table counts, wallet
   decrypt sample count, and queue summary. Treat `restore_drill_failed` or a
   stale-backup error as a production-severity backup alert.
6. Confirm teardown completed and the isolated database/Redis target no longer
   accepts connections. If teardown fails, revoke credentials and delete the
   target manually before closing the ticket.
7. Attach the redacted workflow output and teardown evidence to the evidence
   store, then rotate any temporary recovery credentials used by the drill.

Incident invocation follows the same workflow with the failing environment
removed from service first. Restore into a new database, validate it with
`db:verify-restore`, point API and worker `DATABASE_URL` at the validated target,
then resume traffic. Never overwrite the failed database before reconciliation
is complete.
