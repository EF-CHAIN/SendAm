-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastCustomerInteractionAt" TIMESTAMP(3),
ADD COLUMN     "messagingConsent" TEXT NOT NULL DEFAULT 'opted_in',
ADD COLUMN     "consentSource" TEXT DEFAULT 'system',
ADD COLUMN     "consentUpdatedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "locale" TEXT NOT NULL DEFAULT 'en';
