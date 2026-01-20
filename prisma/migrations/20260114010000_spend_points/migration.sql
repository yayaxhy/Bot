-- Add spend points (1 point per 1 currency spent)
ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "spendPoints" DECIMAL(19, 4) NOT NULL DEFAULT 0;
