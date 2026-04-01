-- Farm system

CREATE TYPE "FarmSeedType" AS ENUM (
  'WHEAT',
  'ROSE',
  'KOI_FLOWER',
  'MYSTERY_FRUIT'
);

CREATE TYPE "FarmActionType" AS ENUM (
  'BALANCE_TO_COINS',
  'POINTS_TO_COINS',
  'COINS_TO_POINTS',
  'PLANT',
  'HARVEST',
  'EXPAND'
);

CREATE TABLE "FarmProfile" (
  "discordUserId" TEXT NOT NULL,
  "coins" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "experience" INTEGER NOT NULL DEFAULT 0,
  "unlockedPlots" INTEGER NOT NULL DEFAULT 4,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FarmProfile_pkey" PRIMARY KEY ("discordUserId"),
  CONSTRAINT "FarmProfile_discordUserId_fkey" FOREIGN KEY ("discordUserId") REFERENCES "Member"("discordUserId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "FarmPlot" (
  "id" TEXT NOT NULL,
  "discordUserId" TEXT NOT NULL,
  "plotIndex" INTEGER NOT NULL,
  "seedType" "FarmSeedType",
  "plantedAt" TIMESTAMP(3),
  "readyAt" TIMESTAMP(3),
  "lastHarvestAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FarmPlot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FarmPlot_discordUserId_fkey" FOREIGN KEY ("discordUserId") REFERENCES "FarmProfile"("discordUserId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "FarmActionLog" (
  "id" TEXT NOT NULL,
  "discordUserId" TEXT NOT NULL,
  "actionType" "FarmActionType" NOT NULL,
  "plotIndex" INTEGER,
  "seedType" "FarmSeedType",
  "balanceDelta" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "pointDelta" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "coinDelta" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "expDelta" INTEGER NOT NULL DEFAULT 0,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FarmActionLog_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FarmActionLog_discordUserId_fkey" FOREIGN KEY ("discordUserId") REFERENCES "FarmProfile"("discordUserId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "FarmPlot_discordUserId_plotIndex_key" ON "FarmPlot"("discordUserId", "plotIndex");
CREATE INDEX "FarmPlot_discordUserId_readyAt_idx" ON "FarmPlot"("discordUserId", "readyAt");
CREATE INDEX "FarmActionLog_discordUserId_createdAt_idx" ON "FarmActionLog"("discordUserId", "createdAt");
CREATE INDEX "FarmActionLog_discordUserId_actionType_createdAt_idx" ON "FarmActionLog"("discordUserId", "actionType", "createdAt");
