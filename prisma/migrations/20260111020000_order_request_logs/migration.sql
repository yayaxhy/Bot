-- Order request logs and clicks
CREATE TABLE IF NOT EXISTS "OrderRequestLog" (
    "orderId" TEXT PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "OrderRequestLog_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Member"("discordUserId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "OrderRequestLog_ownerId_idx"
    ON "OrderRequestLog" ("ownerId");

CREATE TABLE IF NOT EXISTS "OrderRequestClick" (
    "id" TEXT PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "clickedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "OrderRequestClick_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "OrderRequestLog"("orderId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OrderRequestClick_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Member"("discordUserId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "OrderRequestClick_orderId_workerId_key"
    ON "OrderRequestClick" ("orderId", "workerId");

CREATE INDEX IF NOT EXISTS "OrderRequestClick_orderId_idx"
    ON "OrderRequestClick" ("orderId");

CREATE INDEX IF NOT EXISTS "OrderRequestClick_workerId_idx"
    ON "OrderRequestClick" ("workerId");
