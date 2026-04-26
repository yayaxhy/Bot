ALTER TABLE "RedEnvelope"
ADD COLUMN IF NOT EXISTS "keyword" TEXT;

ALTER TABLE "RedEnvelope"
ADD COLUMN IF NOT EXISTS "pendingMessageId" TEXT;

CREATE TABLE IF NOT EXISTS "RedEnvelopeClaim" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "claimerJinleeId" TEXT NOT NULL,
    "claimerDiscordId" TEXT NOT NULL,
    "claimerDisplayName" TEXT,
    "grossAmount" DECIMAL(19,4) NOT NULL,
    "netAmount" DECIMAL(19,4) NOT NULL,
    "transactionId" TEXT,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RedEnvelopeClaim_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RedEnvelopeClaim_envelopeId_claimerJinleeId_key"
ON "RedEnvelopeClaim"("envelopeId", "claimerJinleeId");

CREATE INDEX IF NOT EXISTS "RedEnvelopeClaim_envelopeId_claimedAt_idx"
ON "RedEnvelopeClaim"("envelopeId", "claimedAt");

CREATE INDEX IF NOT EXISTS "RedEnvelopeClaim_claimerJinleeId_claimedAt_idx"
ON "RedEnvelopeClaim"("claimerJinleeId", "claimedAt");

CREATE INDEX IF NOT EXISTS "RedEnvelope_keyword_status_channelId_expiresAt_idx"
ON "RedEnvelope"("keyword", "status", "channelId", "expiresAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'RedEnvelopeClaim_envelopeId_fkey'
      AND table_name = 'RedEnvelopeClaim'
  ) THEN
    ALTER TABLE "RedEnvelopeClaim"
    ADD CONSTRAINT "RedEnvelopeClaim_envelopeId_fkey"
    FOREIGN KEY ("envelopeId") REFERENCES "RedEnvelope"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
  END IF;
END $$;
