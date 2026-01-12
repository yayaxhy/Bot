-- Gift wall unlocks and reward claims
CREATE TABLE IF NOT EXISTS "PeiwanGiftUnlock" (
    "id" TEXT PRIMARY KEY,
    "discordUserId" TEXT NOT NULL,
    "giftName" TEXT NOT NULL,
    "unlockedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "PeiwanGiftUnlock_discordUserId_fkey" FOREIGN KEY ("discordUserId") REFERENCES "Member"("discordUserId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PeiwanGiftUnlock_giftName_fkey" FOREIGN KEY ("giftName") REFERENCES "Gift"("GiftName") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "PeiwanGiftUnlock_discordUserId_giftName_key"
    ON "PeiwanGiftUnlock" ("discordUserId", "giftName");

CREATE INDEX IF NOT EXISTS "PeiwanGiftUnlock_discordUserId_idx"
    ON "PeiwanGiftUnlock" ("discordUserId");

CREATE TABLE IF NOT EXISTS "PeiwanGiftRewardClaim" (
    "id" TEXT PRIMARY KEY,
    "discordUserId" TEXT NOT NULL,
    "rewardKey" TEXT NOT NULL,
    "grantedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "PeiwanGiftRewardClaim_discordUserId_fkey" FOREIGN KEY ("discordUserId") REFERENCES "Member"("discordUserId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "PeiwanGiftRewardClaim_discordUserId_rewardKey_key"
    ON "PeiwanGiftRewardClaim" ("discordUserId", "rewardKey");

CREATE INDEX IF NOT EXISTS "PeiwanGiftRewardClaim_discordUserId_idx"
    ON "PeiwanGiftRewardClaim" ("discordUserId");
