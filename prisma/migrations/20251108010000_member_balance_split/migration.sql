-- Rename balance → totalBalance
ALTER TABLE "Member" RENAME COLUMN "balance" TO "totalBalance";

-- Add income/recharge buckets
ALTER TABLE "Member"
  ADD COLUMN "income" DECIMAL(19,4) NOT NULL DEFAULT 0,
  ADD COLUMN "recharge" DECIMAL(19,4) NOT NULL DEFAULT 0;

-- Initialize new buckets from historic balance values
UPDATE "Member"
SET
  "income" = 0,
  "recharge" = COALESCE("totalBalance", 0);

-- Ensure defaults remain zeroed
ALTER TABLE "Member"
  ALTER COLUMN "totalBalance" SET DEFAULT 0,
  ALTER COLUMN "income" SET DEFAULT 0,
  ALTER COLUMN "recharge" SET DEFAULT 0;
