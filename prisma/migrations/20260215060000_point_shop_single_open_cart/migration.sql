-- Enforce one OPEN cart per user and clean up any historical duplicates.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "discordUserId"
      ORDER BY "updatedAt" DESC, "createdAt" DESC, "id" DESC
    ) AS rn
  FROM "PointShopCart"
  WHERE "status" = 'OPEN'
)
UPDATE "PointShopCart" c
SET
  "status" = 'ABANDONED',
  "updatedAt" = NOW()
FROM ranked r
WHERE c."id" = r."id"
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "PointShopCart_open_user_unique_idx"
ON "PointShopCart" ("discordUserId")
WHERE "status" = 'OPEN';
