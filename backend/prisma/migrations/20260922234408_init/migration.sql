-- CreateEnum
CREATE TYPE "ListStatus" AS ENUM ('active', 'archived', 'deleted');

-- CreateEnum
CREATE TYPE "GiftItemState" AS ENUM ('available', 'claimed', 'purchased');

-- CreateEnum
CREATE TYPE "SharePermissionLevel" AS ENUM ('shared');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftList" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "ListStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiftList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftItem" (
    "id" TEXT NOT NULL,
    "giftListId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "quantity" INTEGER,
    "unitPrice" DECIMAL(65,30),
    "state" "GiftItemState" NOT NULL DEFAULT 'available',
    "claimantUserId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "purchasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiftItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SharePermission" (
    "id" TEXT NOT NULL,
    "giftListId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "permission" "SharePermissionLevel" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SharePermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "GiftItem_giftListId_idx" ON "GiftItem"("giftListId");

-- CreateIndex
CREATE INDEX "SharePermission_giftListId_idx" ON "SharePermission"("giftListId");

-- CreateIndex
CREATE INDEX "SharePermission_recipientUserId_idx" ON "SharePermission"("recipientUserId");

-- CreateIndex
CREATE UNIQUE INDEX "SharePermission_giftListId_recipientUserId_key" ON "SharePermission"("giftListId", "recipientUserId");

-- AddForeignKey
ALTER TABLE "GiftList" ADD CONSTRAINT "GiftList_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftItem" ADD CONSTRAINT "GiftItem_giftListId_fkey" FOREIGN KEY ("giftListId") REFERENCES "GiftList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftItem" ADD CONSTRAINT "GiftItem_claimantUserId_fkey" FOREIGN KEY ("claimantUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharePermission" ADD CONSTRAINT "SharePermission_giftListId_fkey" FOREIGN KEY ("giftListId") REFERENCES "GiftList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharePermission" ADD CONSTRAINT "SharePermission_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharePermission" ADD CONSTRAINT "SharePermission_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
