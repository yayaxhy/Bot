-- Gift active flag + category grouping
ALTER TABLE "Gift" ADD COLUMN IF NOT EXISTS "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "GiftImage" ADD COLUMN IF NOT EXISTS "category" TEXT NOT NULL DEFAULT '默认';
