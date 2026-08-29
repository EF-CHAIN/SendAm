# Customer Identity Migration & Rollback Plan

This document outlines the operational procedures for migrating legacy customer identity records (e.g. non-canonical phone numbers, unlinked wallet records) to the canonical SendAm identity model without data loss or mismatched wallet ownership.

## Pre-Migration Validation

Before executing any identity migration:
1. Ensure a fresh PostgreSQL snapshot is taken:
   ```bash
   pg_dump -Fc "$DATABASE_URL" > /backups/pre-migration-identity-$(date +%s).dump
   ```
2. Run the migration script in dry-run mode:
   ```bash
   node apps/api/scripts/migrate-customer-identities.js --dry-run
   ```
3. Confirm that:
   - `orphanedWalletsCount` is 0.
   - `collisionsCount` is 0.
   - `preMigrationIntegrityOk` is true.

## Migration Execution (Cutover)

1. Execute the migration in transactional mode:
   ```bash
   node apps/api/scripts/migrate-customer-identities.js --apply
   ```
2. The migration tool:
   - Captures pre-update snapshots of modified `User` and `Wallet` rows.
   - Performs atomic batch updates using `prisma.$transaction`.
   - Re-verifies all user-wallet linkages post-update (`verifiedOwnershipCount`).

## Post-Migration Verification

Verify customer wallet access and balance consistency:
```bash
node apps/api/scripts/validate-production-db.js
```

## Rollback Plan

If any unexpected collisions, ownership mismatches, or downstream service errors occur during or immediately following migration:

1. **Automated Script Rollback**:
   Revert using the captured snapshot data:
   ```bash
   node apps/api/scripts/migrate-customer-identities.js --rollback --snapshot=/path/to/snapshot.json
   ```

2. **Database Point-in-Time Recovery**:
   If script rollback is insufficient, restore the pre-migration dump:
   ```bash
   pg_restore --clean --if-exists -d "$DATABASE_URL" /backups/pre-migration-identity-<timestamp>.dump
   ```

3. Validate system health and restart services:
   ```bash
   npm run test
   ```
