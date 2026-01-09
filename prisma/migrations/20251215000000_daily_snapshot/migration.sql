-- Create daily snapshots for per-day spend/earn deltas
CREATE TABLE "DailySnapshot" (
    "date" DATE NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "totalEarn" DECIMAL(19,4) NOT NULL,
    "totalSpent" DECIMAL(19,4) NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT "DailySnapshot_pkey" PRIMARY KEY ("date","discordUserId"),
    CONSTRAINT "DailySnapshot_discordUserId_fkey" FOREIGN KEY ("discordUserId") REFERENCES "Member"("discordUserId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "DailySnapshot_date_idx" ON "DailySnapshot"("date");
