-- Track per-channel leaderboard posts to retry failed channels
CREATE TABLE IF NOT EXISTS "LeaderboardPostChannel" (
    "id" TEXT PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "periodStart" TIMESTAMPTZ NOT NULL,
    "channelId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "LeaderboardPostChannel_kind_periodStart_channelId_key"
    ON "LeaderboardPostChannel" ("kind", "periodStart", "channelId");

CREATE INDEX IF NOT EXISTS "LeaderboardPostChannel_kind_idx"
    ON "LeaderboardPostChannel" ("kind");

CREATE INDEX IF NOT EXISTS "LeaderboardPostChannel_channelId_idx"
    ON "LeaderboardPostChannel" ("channelId");
