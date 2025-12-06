-- Create table for lottery pity counter
CREATE TABLE "LotteryPity" (
  "userId" TEXT PRIMARY KEY,
  "missCount" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "LotteryPity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Member"("discordUserId") ON DELETE CASCADE ON UPDATE CASCADE
);