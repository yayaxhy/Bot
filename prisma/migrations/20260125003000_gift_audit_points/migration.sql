-- Add pointsEarned to gift_audit to record loyalty points per gift
ALTER TABLE "gift_audit"
ADD COLUMN IF NOT EXISTS "pointsEarned" DECIMAL(19,4) NOT NULL DEFAULT 0;
