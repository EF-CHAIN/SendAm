-- Supporting indexes for bounded cursor (keyset) pagination and the new
-- server-side admin filters. Keyset pagination walks the stable
-- (sortField, id) tuple, so a composite (sortField, id) index lets Postgres
-- seek straight to the page instead of offset-scanning. Filter columns get
-- leading-column indexes so status/asset/rail/action/actorType scans use an
-- index rather than a sequential scan at production volumes.

CREATE INDEX "User_createdAt_id_idx" ON "User"("createdAt", "id");

CREATE INDEX "Wallet_chain_createdAt_idx" ON "Wallet"("chain", "createdAt");
CREATE INDEX "Wallet_createdAt_id_idx" ON "Wallet"("createdAt", "id");

CREATE INDEX "Transaction_asset_createdAt_idx" ON "Transaction"("asset", "createdAt");
CREATE INDEX "Transaction_status_createdAt_idx" ON "Transaction"("status", "createdAt");
CREATE INDEX "Transaction_createdAt_id_idx" ON "Transaction"("createdAt", "id");
CREATE INDEX "Transaction_txHash_idx" ON "Transaction"("txHash");
CREATE INDEX "Transaction_providerTransactionId_idx" ON "Transaction"("providerTransactionId");

CREATE INDEX "KycProfile_status_updatedAt_idx" ON "KycProfile"("status", "updatedAt");
CREATE INDEX "KycProfile_updatedAt_id_idx" ON "KycProfile"("updatedAt", "id");

CREATE INDEX "AuditLog_createdAt_id_idx" ON "AuditLog"("createdAt", "id");
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");
CREATE INDEX "AuditLog_actorType_createdAt_idx" ON "AuditLog"("actorType", "createdAt");
CREATE INDEX "AuditLog_entityType_createdAt_idx" ON "AuditLog"("entityType", "createdAt");
CREATE INDEX "AuditLog_entityId_createdAt_idx" ON "AuditLog"("entityId", "createdAt");
