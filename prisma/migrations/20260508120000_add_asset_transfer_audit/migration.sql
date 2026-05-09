CREATE TABLE "AssetTransferAudit" (
    "id" TEXT NOT NULL,
    "operatorDiscordId" TEXT,
    "sourceDiscordId" TEXT NOT NULL,
    "targetDiscordId" TEXT NOT NULL,
    "sourceJinleeId" TEXT,
    "targetJinleeId" TEXT,
    "forceMerge" BOOLEAN NOT NULL DEFAULT false,
    "sourceSnapshot" JSONB,
    "targetSnapshot" JSONB,
    "transferred" JSONB,
    "changed" JSONB,
    "warnings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetTransferAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AssetTransferAudit_sourceDiscordId_createdAt_idx" ON "AssetTransferAudit"("sourceDiscordId", "createdAt");
CREATE INDEX "AssetTransferAudit_targetDiscordId_createdAt_idx" ON "AssetTransferAudit"("targetDiscordId", "createdAt");
CREATE INDEX "AssetTransferAudit_createdAt_idx" ON "AssetTransferAudit"("createdAt");
