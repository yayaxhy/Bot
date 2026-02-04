-- CreateEnum
CREATE TYPE "BlockStackStatus" AS ENUM ('ACTIVE', 'COLLAPSED', 'SETTLED');
CREATE TYPE "BlockStackAction" AS ENUM ('SINGLE', 'TEN', 'SETTLE');

-- CreateTable
CREATE TABLE "BlockStackGame" (
  "id" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "messageId" TEXT,
  "status" "BlockStackStatus" NOT NULL DEFAULT 'ACTIVE',
  "totalBlocks" INTEGER NOT NULL DEFAULT 0,
  "totalSingleDraws" INTEGER NOT NULL DEFAULT 0,
  "totalTenDraws" INTEGER NOT NULL DEFAULT 0,
  "totalRevenue" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "settledAt" TIMESTAMP(3),
  "settledById" TEXT,
  "settledAmount" DECIMAL(19,4),
  "collapsedAt" TIMESTAMP(3),
  "collapsedById" TEXT,
  "collapsedByAction" "BlockStackAction",
  "collapseChance" DECIMAL(7,4),
  "collapseRoll" DECIMAL(7,4),
  "collapseEnvelopeAmount" DECIMAL(19,4),
  "collapseRewardUserId" TEXT,
  "collapseRewardGross" DECIMAL(19,4),
  "collapseRewardNet" DECIMAL(19,4),
  "collapseRewardTransactionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BlockStackGame_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockStackPlayer" (
  "id" TEXT NOT NULL,
  "gameId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "singlePicked" BOOLEAN NOT NULL DEFAULT false,
  "singleBlocks" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BlockStackPlayer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockStackDraw" (
  "id" TEXT NOT NULL,
  "gameId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "action" "BlockStackAction" NOT NULL,
  "blocksAdded" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BlockStackDraw_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BlockStackGame_channelId_status_idx" ON "BlockStackGame"("channelId", "status");

CREATE UNIQUE INDEX "BlockStackPlayer_gameId_userId_key" ON "BlockStackPlayer"("gameId", "userId");
CREATE INDEX "BlockStackPlayer_userId_idx" ON "BlockStackPlayer"("userId");

CREATE INDEX "BlockStackDraw_gameId_createdAt_idx" ON "BlockStackDraw"("gameId", "createdAt");
CREATE INDEX "BlockStackDraw_userId_createdAt_idx" ON "BlockStackDraw"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "BlockStackPlayer"
  ADD CONSTRAINT "BlockStackPlayer_gameId_fkey"
  FOREIGN KEY ("gameId") REFERENCES "BlockStackGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BlockStackDraw"
  ADD CONSTRAINT "BlockStackDraw_gameId_fkey"
  FOREIGN KEY ("gameId") REFERENCES "BlockStackGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;


