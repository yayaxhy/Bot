-- Invite reward tables (no changes to existing Lottery migrations)

-- Tracks first time a user ever joins the target guild
CREATE TABLE "GuildJoinRecord" (
    "userId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "firstJoinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GuildJoinRecord_pkey" PRIMARY KEY ("userId")
);

CREATE INDEX "GuildJoinRecord_guildId_idx" ON "GuildJoinRecord"("guildId");

-- Records a single invite reward (2 元) paid for an invitee
CREATE TABLE "InviteLinkUsage" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "inviteeId" TEXT NOT NULL,
    "inviterId" TEXT NOT NULL,
    "code" TEXT,
    "rewardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rewardAmount" DECIMAL(19,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InviteLinkUsage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InviteLinkUsage_inviteeId_key" ON "InviteLinkUsage"("inviteeId");
CREATE INDEX "InviteLinkUsage_guildId_inviterId_idx" ON "InviteLinkUsage"("guildId", "inviterId");

ALTER TABLE "InviteLinkUsage"
  ADD CONSTRAINT "InviteLinkUsage_inviterId_fkey"
    FOREIGN KEY ("inviterId") REFERENCES "Member"("discordUserId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "InviteLinkUsage_inviteeId_fkey"
    FOREIGN KEY ("inviteeId") REFERENCES "Member"("discordUserId") ON DELETE CASCADE ON UPDATE CASCADE;
