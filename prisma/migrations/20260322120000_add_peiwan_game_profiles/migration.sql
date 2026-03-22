-- Per-game peiwan tier profiles

CREATE TYPE "PeiwanGameCode" AS ENUM (
  'LOL',
  'CSGO',
  'VAL',
  'NARAKA',
  'OW',
  'APEX',
  'DELTA',
  'MARVEL',
  'TFT',
  'TARKOV',
  'DOTA',
  'COD',
  'CHAT',
  'SINGER'
);

CREATE TYPE "PeiwanGameTier" AS ENUM (
  'ENTERTAINMENT',
  'TRAINEE',
  'TECH',
  'MASTER',
  'DEMON_GUARD'
);

CREATE TABLE "PeiwanGameProfile" (
  "id" TEXT NOT NULL,
  "peiwanId" INTEGER NOT NULL,
  "discordUserId" TEXT NOT NULL,
  "gameCode" "PeiwanGameCode" NOT NULL,
  "tier" "PeiwanGameTier" NOT NULL,
  "source" TEXT,
  "sourceRoleId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PeiwanGameProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PeiwanGameProfile_peiwanId_gameCode_key"
  ON "PeiwanGameProfile"("peiwanId", "gameCode");

CREATE INDEX "PeiwanGameProfile_discordUserId_idx"
  ON "PeiwanGameProfile"("discordUserId");

CREATE INDEX "PeiwanGameProfile_gameCode_tier_idx"
  ON "PeiwanGameProfile"("gameCode", "tier");

ALTER TABLE "PeiwanGameProfile"
  ADD CONSTRAINT "PeiwanGameProfile_peiwanId_fkey"
  FOREIGN KEY ("peiwanId") REFERENCES "PEIWAN"("PEIWANID")
  ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "PeiwanGameProfile" (
  "id",
  "peiwanId",
  "discordUserId",
  "gameCode",
  "tier",
  "source",
  "createdAt",
  "updatedAt"
)
SELECT
  concat('PGP', replace(gen_random_uuid()::text, '-', '')),
  src."PEIWANID",
  src."discordUserId",
  src."gameCode"::"PeiwanGameCode",
  CASE src."type"::text
    WHEN '大神陪玩' THEN 'MASTER'
    WHEN '技术陪玩' THEN 'TECH'
    ELSE 'ENTERTAINMENT'
  END::"PeiwanGameTier",
  'LEGACY_MIGRATION',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM (
  SELECT "PEIWANID", "discordUserId", "type", 'LOL' AS "gameCode" FROM "PEIWAN" WHERE "LOL" = TRUE
  UNION ALL
  SELECT "PEIWANID", "discordUserId", "type", 'CSGO' AS "gameCode" FROM "PEIWAN" WHERE "CSGO" = TRUE
  UNION ALL
  SELECT "PEIWANID", "discordUserId", "type", 'VAL' AS "gameCode" FROM "PEIWAN" WHERE "Valorant" = TRUE
  UNION ALL
  SELECT "PEIWANID", "discordUserId", "type", 'NARAKA' AS "gameCode" FROM "PEIWAN" WHERE "Naraka" = TRUE
  UNION ALL
  SELECT "PEIWANID", "discordUserId", "type", 'OW' AS "gameCode" FROM "PEIWAN" WHERE "OW2" = TRUE
  UNION ALL
  SELECT "PEIWANID", "discordUserId", "type", 'APEX' AS "gameCode" FROM "PEIWAN" WHERE "APEX" = TRUE
  UNION ALL
  SELECT "PEIWANID", "discordUserId", "type", 'DELTA' AS "gameCode" FROM "PEIWAN" WHERE "deltaForce" = TRUE
  UNION ALL
  SELECT "PEIWANID", "discordUserId", "type", 'MARVEL' AS "gameCode" FROM "PEIWAN" WHERE "marvel" = TRUE
  UNION ALL
  SELECT "PEIWANID", "discordUserId", "type", 'TFT' AS "gameCode" FROM "PEIWAN" WHERE "TFT" = TRUE
  UNION ALL
  SELECT "PEIWANID", "discordUserId", "type", 'TARKOV' AS "gameCode" FROM "PEIWAN" WHERE "tarkov" = TRUE
  UNION ALL
  SELECT "PEIWANID", "discordUserId", "type", 'DOTA' AS "gameCode" FROM "PEIWAN" WHERE "DOTA" = TRUE
  UNION ALL
  SELECT "PEIWANID", "discordUserId", "type", 'COD' AS "gameCode" FROM "PEIWAN" WHERE "COD" = TRUE
  UNION ALL
  SELECT "PEIWANID", "discordUserId", "type", 'CHAT' AS "gameCode" FROM "PEIWAN" WHERE "chat" = TRUE
  UNION ALL
  SELECT "PEIWANID", "discordUserId", "type", 'SINGER' AS "gameCode" FROM "PEIWAN" WHERE "singer" = TRUE
) AS src;

ALTER TABLE "PEIWAN"
  DROP COLUMN "techTag",
  DROP COLUMN "LOL",
  DROP COLUMN "CSGO",
  DROP COLUMN "Valorant",
  DROP COLUMN "Naraka",
  DROP COLUMN "OW2",
  DROP COLUMN "APEX",
  DROP COLUMN "deltaForce",
  DROP COLUMN "marvel",
  DROP COLUMN "singer",
  DROP COLUMN "PUBG",
  DROP COLUMN "TFT",
  DROP COLUMN "R6",
  DROP COLUMN "tarkov",
  DROP COLUMN "chat",
  DROP COLUMN "steam",
  DROP COLUMN "DOTA",
  DROP COLUMN "COD";
