ALTER TABLE "VipBenefitProfile"
ADD COLUMN IF NOT EXISTS "lastSettledVipLevel" INTEGER NOT NULL DEFAULT 0;

WITH vip_levels AS (
  SELECT
    m."discordUserId",
    CASE
      WHEN m."totalSpent" >= 880000 THEN 12
      WHEN m."totalSpent" >= 520000 THEN 11
      WHEN m."totalSpent" >= 340000 THEN 10
      WHEN m."totalSpent" >= 210000 THEN 9
      WHEN m."totalSpent" >= 120000 THEN 8
      WHEN m."totalSpent" >= 50000 THEN 7
      WHEN m."totalSpent" >= 20000 THEN 6
      WHEN m."totalSpent" >= 10000 THEN 5
      WHEN m."totalSpent" >= 5000 THEN 4
      WHEN m."totalSpent" >= 3000 THEN 3
      WHEN m."totalSpent" >= 1500 THEN 2
      WHEN m."totalSpent" >= 500 THEN 1
      ELSE 0
    END AS vip_level
  FROM "Member" m
)
INSERT INTO "VipBenefitProfile" ("discordUserId", "lastSettledVipLevel")
SELECT
  vip_levels."discordUserId",
  vip_levels.vip_level
FROM vip_levels
ON CONFLICT ("discordUserId") DO UPDATE
SET
  "lastSettledVipLevel" = EXCLUDED."lastSettledVipLevel",
  "updatedAt" = NOW();
