CREATE TABLE "blacklist" (
    "id" TEXT NOT NULL,
    "blockerId" TEXT NOT NULL,
    "blockedId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blacklist_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "blacklist_blockerId_blockedId_key" ON "blacklist"("blockerId", "blockedId");
CREATE INDEX "blacklist_blockedId_idx" ON "blacklist"("blockedId");
CREATE INDEX "blacklist_blockerId_createdAt_idx" ON "blacklist"("blockerId", "createdAt");

ALTER TABLE "blacklist"
ADD CONSTRAINT "blacklist_blockerId_fkey"
FOREIGN KEY ("blockerId") REFERENCES "Member"("discordUserId")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE "blacklist"
ADD CONSTRAINT "blacklist_blockedId_fkey"
FOREIGN KEY ("blockedId") REFERENCES "Member"("discordUserId")
ON DELETE CASCADE
ON UPDATE CASCADE;
