ALTER TABLE "ScratchTicket"
DROP COLUMN IF EXISTS "prizeImageUrl",
DROP COLUMN IF EXISTS "soldMessageId",
DROP COLUMN IF EXISTS "purchaseTransactionId",
DROP COLUMN IF EXISTS "rewardTransactionId";
