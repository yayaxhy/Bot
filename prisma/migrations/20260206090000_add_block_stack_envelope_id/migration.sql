-- Add collapseEnvelopeId for linking block stack games to red envelopes
ALTER TABLE "BlockStackGame" ADD COLUMN "collapseEnvelopeId" TEXT;

CREATE INDEX "BlockStackGame_collapseEnvelopeId_idx" ON "BlockStackGame"("collapseEnvelopeId");
