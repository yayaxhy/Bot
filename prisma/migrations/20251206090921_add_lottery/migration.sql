-- CreateEnum
CREATE TYPE "LotteryPool" AS ENUM ('NORMAL', 'MEDIUM', 'ADVANCED', 'SPECIAL');

-- CreateTable
CREATE TABLE "LotteryPrize" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pool" "LotteryPool" NOT NULL,
    "weight" INTEGER NOT NULL,
    "unlimited" BOOLEAN NOT NULL DEFAULT false,
    "stock" INTEGER,
    "imageUrl" TEXT,
    "animationUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "LotteryPrize_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LotteryDraw" (
    "id" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "requestId" TEXT,
    "userId" TEXT NOT NULL,
    "pool" "LotteryPool" NOT NULL,
    "prizeId" TEXT,
    "cost" DECIMAL(19,4) NOT NULL,
    "random" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LotteryDraw_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LotteryDraw_nonce_key" ON "LotteryDraw"("nonce");

-- CreateIndex
CREATE INDEX "LotteryDraw_userId_createdAt_idx" ON "LotteryDraw"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "LotteryDraw_pool_createdAt_idx" ON "LotteryDraw"("pool", "createdAt");

-- AddForeignKey
ALTER TABLE "LotteryDraw" ADD CONSTRAINT "LotteryDraw_prizeId_fkey" FOREIGN KEY ("prizeId") REFERENCES "LotteryPrize"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LotteryDraw" ADD CONSTRAINT "LotteryDraw_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Member"("discordUserId") ON DELETE RESTRICT ON UPDATE CASCADE;
