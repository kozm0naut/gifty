-- CreateEnum
CREATE TYPE "OutboxKind" AS ENUM ('invite', 'confirmation');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('queued', 'sending', 'sent', 'failed', 'superseded');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "verificationCreatedAt" TIMESTAMP(3),
ADD COLUMN     "verificationExpiresAt" TIMESTAMP(3),
ADD COLUMN     "verificationTokenHash" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OutboxMessage" (
    "id" TEXT NOT NULL,
    "kind" "OutboxKind" NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "listId" TEXT,
    "userId" TEXT,
    "subject" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "bodyHtml" TEXT,
    "status" "OutboxStatus" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutboxMessage_status_nextAttemptAt_idx" ON "OutboxMessage"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OutboxMessage_userId_idx" ON "OutboxMessage"("userId");

-- CreateIndex
CREATE INDEX "OutboxMessage_listId_idx" ON "OutboxMessage"("listId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxMessage_listId_recipientEmail_key" ON "OutboxMessage"("listId", "recipientEmail");

-- AddForeignKey
ALTER TABLE "OutboxMessage" ADD CONSTRAINT "OutboxMessage_listId_fkey" FOREIGN KEY ("listId") REFERENCES "GiftList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxMessage" ADD CONSTRAINT "OutboxMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Grandfathering: all pre-existing accounts are confirmed (feature 004
-- Assumptions). Pinned to this migration's own timestamp. New accounts created
-- with email enabled are the only ones born unconfirmed.
UPDATE "User" SET "verifiedAt" = '2026-10-05 13:56:26.000+00' WHERE "verifiedAt" IS NULL;
