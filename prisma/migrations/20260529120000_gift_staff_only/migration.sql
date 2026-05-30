-- Restrict selected gifts so only fixed customer-service accounts can send them.
ALTER TABLE "Gift"
ADD COLUMN IF NOT EXISTS "staffOnlyGift" BOOLEAN NOT NULL DEFAULT false;
