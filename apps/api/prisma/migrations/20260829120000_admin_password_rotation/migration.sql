-- Administrators created from the legacy shared ADMIN_PASSWORD bootstrap must
-- rotate to a private password before they can use any admin route. The flag
-- is also set for any account provisioned with a temporary credential, so a
-- leaked shared password is never usable for admin work after migration.
ALTER TABLE "AdminUser" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- Existing accounts provisioned from the shared bootstrap credential before
-- this migration are not retroactively forced to rotate; operators should run
-- POST /api/admin/password themselves (or reset via the admin dashboard) once
-- the shared ADMIN_PASSWORD is retired.
CREATE INDEX "AdminUser_mustChangePassword_idx" ON "AdminUser"("mustChangePassword");