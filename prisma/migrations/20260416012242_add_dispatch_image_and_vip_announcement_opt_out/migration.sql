CREATE TABLE IF NOT EXISTS "VipBenefitProfile" (
  "discordUserId" TEXT NOT NULL,
  "roleOptOut" BOOLEAN NOT NULL DEFAULT false,
  "announcementEnabled" BOOLEAN NOT NULL DEFAULT true,
  "dispatchImageUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "VipBenefitProfile_pkey" PRIMARY KEY ("discordUserId"),
  CONSTRAINT "VipBenefitProfile_discordUserId_fkey"
    FOREIGN KEY ("discordUserId") REFERENCES "Member"("discordUserId")
    ON DELETE CASCADE ON UPDATE CASCADE
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Member' AND column_name = 'VIPRoleOptOut'
  ) THEN
    EXECUTE '
      INSERT INTO "VipBenefitProfile" ("discordUserId", "roleOptOut")
      SELECT "discordUserId", COALESCE("VIPRoleOptOut", false)
      FROM "Member"
      ON CONFLICT ("discordUserId") DO UPDATE
      SET "roleOptOut" = EXCLUDED."roleOptOut"
    ';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'BossProfile' AND column_name = 'dispatchImageUrl'
  ) THEN
    EXECUTE '
      INSERT INTO "VipBenefitProfile" ("discordUserId", "dispatchImageUrl")
      SELECT "bossId", "dispatchImageUrl"
      FROM "BossProfile"
      WHERE "dispatchImageUrl" IS NOT NULL AND btrim("dispatchImageUrl") <> ''''
      ON CONFLICT ("discordUserId") DO UPDATE
      SET "dispatchImageUrl" = EXCLUDED."dispatchImageUrl"
    ';
  END IF;
END $$;

ALTER TABLE "Member"
DROP COLUMN IF EXISTS "VIPRoleOptOut";

ALTER TABLE "BossProfile"
DROP COLUMN IF EXISTS "dispatchImageUrl";
