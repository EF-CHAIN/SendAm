ALTER TABLE "User"
ADD COLUMN "supportUnrecognizedCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "AuditLog"
ADD COLUMN "currentHash" TEXT,
ADD COLUMN "hashAlgorithm" TEXT NOT NULL DEFAULT 'legacy-hmac-sha256';

UPDATE "AuditLog"
SET "currentHash" = "hash"
WHERE "hash" IS NOT NULL;

CREATE UNIQUE INDEX "AuditLog_currentHash_key" ON "AuditLog"("currentHash");

CREATE TABLE "AuditChainHead" (
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
LIMIT 1;
