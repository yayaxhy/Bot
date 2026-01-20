-- Add display names to order request logs
ALTER TABLE "OrderRequestLog"
  ADD COLUMN IF NOT EXISTS "ownerDisplayName" TEXT;

ALTER TABLE "OrderRequestClick"
  ADD COLUMN IF NOT EXISTS "workerDisplayName" TEXT;
