ALTER TABLE "Member"
ADD COLUMN IF NOT EXISTS "baseCommissionRate" DECIMAL(7,6);

UPDATE "Member"
SET "baseCommissionRate" = "commissionRate"
WHERE "baseCommissionRate" IS NULL;

ALTER TABLE "Member"
ALTER COLUMN "baseCommissionRate" SET DEFAULT 0.75;

ALTER TABLE "Member"
ALTER COLUMN "baseCommissionRate" SET NOT NULL;

ALTER TABLE "PEIWAN"
ADD COLUMN IF NOT EXISTS "baseCommissionRate" DECIMAL(7,6);

UPDATE "PEIWAN"
SET "baseCommissionRate" = "commissionRate"
WHERE "baseCommissionRate" IS NULL;

ALTER TABLE "PEIWAN"
ALTER COLUMN "baseCommissionRate" SET DEFAULT 0.75;

ALTER TABLE "PEIWAN"
ALTER COLUMN "baseCommissionRate" SET NOT NULL;
