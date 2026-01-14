-- Record leaderboard send status to avoid duplicates after restart
CREATE TABLE IF NOT EXISTS "LeaderboardPost" (
    "id" TEXT PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "periodStart" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "LeaderboardPost_kind_periodStart_key"
    ON "LeaderboardPost" ("kind", "periodStart");

CREATE INDEX IF NOT EXISTS "LeaderboardPost_kind_idx"
    ON "LeaderboardPost" ("kind");
