CREATE TABLE IF NOT EXISTS "VoicePointSession" (
  "id" TEXT NOT NULL,
  "discordUserId" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leftAt" TIMESTAMP(3),
  "eligibleSeconds" INTEGER NOT NULL DEFAULT 0,
  "pointsAwarded" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "closeReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VoicePointSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "VoicePointLedger" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "discordUserId" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "durationSeconds" INTEGER NOT NULL,
  "points" DECIMAL(19,4) NOT NULL,
  "ruleVersion" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VoicePointLedger_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'VoicePointSession_discordUserId_fkey'
  ) THEN
    ALTER TABLE "VoicePointSession"
      ADD CONSTRAINT "VoicePointSession_discordUserId_fkey"
      FOREIGN KEY ("discordUserId")
      REFERENCES "Member"("discordUserId")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'VoicePointLedger_discordUserId_fkey'
  ) THEN
    ALTER TABLE "VoicePointLedger"
      ADD CONSTRAINT "VoicePointLedger_discordUserId_fkey"
      FOREIGN KEY ("discordUserId")
      REFERENCES "Member"("discordUserId")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'VoicePointLedger_sessionId_fkey'
  ) THEN
    ALTER TABLE "VoicePointLedger"
      ADD CONSTRAINT "VoicePointLedger_sessionId_fkey"
      FOREIGN KEY ("sessionId")
      REFERENCES "VoicePointSession"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "VoicePointLedger_sessionId_key"
ON "VoicePointLedger" ("sessionId");

CREATE INDEX IF NOT EXISTS "VoicePointSession_discordUserId_joinedAt_idx"
ON "VoicePointSession" ("discordUserId", "joinedAt");

CREATE INDEX IF NOT EXISTS "VoicePointSession_discordUserId_leftAt_idx"
ON "VoicePointSession" ("discordUserId", "leftAt");

CREATE INDEX IF NOT EXISTS "VoicePointSession_guildId_channelId_joinedAt_idx"
ON "VoicePointSession" ("guildId", "channelId", "joinedAt");

CREATE INDEX IF NOT EXISTS "VoicePointLedger_discordUserId_createdAt_idx"
ON "VoicePointLedger" ("discordUserId", "createdAt");

CREATE INDEX IF NOT EXISTS "VoicePointLedger_guildId_channelId_createdAt_idx"
ON "VoicePointLedger" ("guildId", "channelId", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "VoicePointSession_open_user_unique_idx"
ON "VoicePointSession" ("discordUserId")
WHERE "leftAt" IS NULL;
