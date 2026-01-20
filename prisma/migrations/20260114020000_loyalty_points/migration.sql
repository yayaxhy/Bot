-- Loyalty points (1 point per 1 currency spent)
CREATE TABLE IF NOT EXISTS "LoyaltyPoint" (
    "discordUserId" TEXT PRIMARY KEY,
    "points" DECIMAL(19, 4) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "LoyaltyPoint_discordUserId_fkey"
      FOREIGN KEY ("discordUserId") REFERENCES "Member"("discordUserId")
      ON DELETE CASCADE ON UPDATE CASCADE
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Member' AND column_name = 'spendPoints'
  ) THEN
    INSERT INTO "LoyaltyPoint" ("discordUserId", "points", "createdAt", "updatedAt")
    SELECT "discordUserId", "spendPoints", now(), now()
    FROM "Member"
    WHERE "spendPoints" IS NOT NULL
    ON CONFLICT ("discordUserId")
    DO UPDATE SET "points" = EXCLUDED."points", "updatedAt" = now();

    ALTER TABLE "Member" DROP COLUMN "spendPoints";
  END IF;
END $$;
