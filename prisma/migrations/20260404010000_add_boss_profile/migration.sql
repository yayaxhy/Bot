CREATE TABLE IF NOT EXISTS "BossProfile" (
  "bossId" TEXT NOT NULL,
  "displayName" TEXT,
  "spendLevelLabel" TEXT,
  "styleLabel" TEXT,
  "preferredCompanionLabel" TEXT,
  "activeWindowLabel" TEXT,
  "repeatWorkerLabel" TEXT,
  "rankLabel" TEXT,
  "topGames" JSONB,
  "evidenceLines" JSONB,
  "totalSpentSnapshot" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "totalBalanceSnapshot" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "totalRequestCount" INTEGER NOT NULL DEFAULT 0,
  "sampledRequestCount" INTEGER NOT NULL DEFAULT 0,
  "totalEndedOrderCount" INTEGER NOT NULL DEFAULT 0,
  "sampledEndedOrderCount" INTEGER NOT NULL DEFAULT 0,
  "averageSpendPerOrder" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "averageUnitPrice" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "averageClickCount" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "firstSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BossProfile_pkey" PRIMARY KEY ("bossId"),
  CONSTRAINT "BossProfile_bossId_fkey"
    FOREIGN KEY ("bossId") REFERENCES "Member"("discordUserId")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "BossProfile_updatedAt_idx"
  ON "BossProfile"("updatedAt");
