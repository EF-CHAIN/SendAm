-- Add sanctions and custody compliance fields to KycProfile

ALTER TABLE "KycProfile"
ADD COLUMN "sanctionsStatus" TEXT NOT NULL DEFAULT 'not_screened';

ALTER TABLE "KycProfile"
ADD COLUMN "sanctionsScreenedAt" TIMESTAMP(3);

ALTER TABLE "KycProfile"
ADD COLUMN "custodyStatus" TEXT NOT NULL DEFAULT 'not_reviewed';

ALTER TABLE "KycProfile"
ADD COLUMN "custodyReviewedAt" TIMESTAMP(3);

ALTER TABLE "KycProfile"
ADD COLUMN "deniedReason" TEXT;

CREATE INDEX "KycProfile_sanctionsStatus_idx" ON "KycProfile" ("sanctionsStatus");
CREATE INDEX "KycProfile_custodyStatus_idx" ON "KycProfile" ("custodyStatus");
