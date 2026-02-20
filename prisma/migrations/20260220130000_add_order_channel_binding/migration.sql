CREATE TABLE IF NOT EXISTS "BossChannelBinding" (
  "channelId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BossChannelBinding_pkey" PRIMARY KEY ("channelId")
);

CREATE INDEX IF NOT EXISTS "BossChannelBinding_ownerId_enabled_idx"
  ON "BossChannelBinding"("ownerId", "enabled");

CREATE INDEX IF NOT EXISTS "BossChannelBinding_enabled_updatedAt_idx"
  ON "BossChannelBinding"("enabled", "updatedAt");
