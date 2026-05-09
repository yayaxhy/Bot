CREATE TABLE "DiscordMigrationAudit" (
    "id" TEXT NOT NULL,
    "operatorDiscordId" TEXT,
    "oldDiscordId" TEXT NOT NULL,
    "newDiscordId" TEXT NOT NULL,
    "archiveDiscordId" TEXT,
    "sourceJinleeId" TEXT,
    "forceTakeover" BOOLEAN NOT NULL DEFAULT false,
    "takeoverSnapshot" JSONB,
    "changed" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscordMigrationAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DiscordMigrationAudit_oldDiscordId_createdAt_idx" ON "DiscordMigrationAudit"("oldDiscordId", "createdAt");
CREATE INDEX "DiscordMigrationAudit_newDiscordId_createdAt_idx" ON "DiscordMigrationAudit"("newDiscordId", "createdAt");
CREATE INDEX "DiscordMigrationAudit_createdAt_idx" ON "DiscordMigrationAudit"("createdAt");
