# Admin account migration and rollback

## Rollout

1. Back up PostgreSQL, deploy, and run `npm run prisma:deploy --workspace=apps/api`.
2. Set `ADMIN_BOOTSTRAP_EMAIL` to the initial operator's individual email and retain the existing `ADMIN_PASSWORD` for this deployment. The first successful login provisions that operator as an administrator. Old shared tokens stop working when the new code starts, while the password remains usable only with the configured email until provisioning succeeds.
3. Sign in, invite a second administrator, and verify both accounts. Invitations expire after 48 hours and their tokens are stored only as hashes.
4. Remove `ADMIN_PASSWORD` and `ADMIN_BOOTSTRAP_EMAIL`, then restart the API.

The roles are `read_only`, `compliance`, `operations`, and `administrator`. Role changes, disablement, and password resets revoke all sessions immediately. The final enabled administrator cannot be disabled or demoted.

## Rollback

Prefer rolling the application back while leaving the additive tables in place. Temporarily restore `ADMIN_PASSWORD` and the previous application version; no customer tables are changed. After resolving the incident, redeploy this version and repeat the rollout. If the tables must be removed, first export `AdminUser`, `AdminSession`, `AdminInvitation`, `AdminRole`, and related `AuditLog` rows. Dropping operator tables destroys audit and session history and is not recommended.
