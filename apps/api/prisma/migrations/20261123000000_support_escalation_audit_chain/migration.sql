ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "supportUnrecognizedCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "AuditLog"
ADD COLUMN IF NOT EXISTS "previousHash" TEXT,
ADD COLUMN IF NOT EXISTS "hash" TEXT,
ADD COLUMN IF NOT EXISTS "currentHash" TEXT,
ADD COLUMN IF NOT EXISTS "hashAlgorithm" TEXT NOT NULL DEFAULT 'legacy-hmac-sha256';

UPDATE "AuditLog"
SET "currentHash" = "hash"
WHERE "currentHash" IS NULL
  AND "hash" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "AuditLog_previousHash_key" ON "AuditLog"("previousHash");
CREATE UNIQUE INDEX IF NOT EXISTS "AuditLog_hash_key" ON "AuditLog"("hash");
CREATE UNIQUE INDEX IF NOT EXISTS "AuditLog_currentHash_key" ON "AuditLog"("currentHash");

CREATE TABLE IF NOT EXISTS "AuditChainHead" (
    "id" TEXT NOT NULL DEFAULT 'primary',
    "currentHash" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditChainHead_pkey" PRIMARY KEY ("id")
);

INSERT INTO "AuditChainHead" ("id", "currentHash")
SELECT 'primary', COALESCE("currentHash", "hash")
FROM "AuditLog" AS log
WHERE COALESCE("currentHash", "hash") IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "AuditLog" AS child
    WHERE child."previousHash" = COALESCE(log."currentHash", log."hash")
  )
ORDER BY log."createdAt" DESC, log."id" DESC
LIMIT 1
ON CONFLICT ("id") DO UPDATE
SET "currentHash" = COALESCE(EXCLUDED."currentHash", "AuditChainHead"."currentHash"),
    "updatedAt" = CURRENT_TIMESTAMP;
