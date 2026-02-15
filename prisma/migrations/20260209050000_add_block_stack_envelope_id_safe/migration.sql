ALTER TABLE "BlockStackGame"
ADD COLUMN IF NOT EXISTS "collapseEnvelopeId" TEXT;

CREATE INDEX IF NOT EXISTS "BlockStackGame_collapseEnvelopeId_idx"
ON "BlockStackGame"("collapseEnvelopeId");