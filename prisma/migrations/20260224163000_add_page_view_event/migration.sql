CREATE TABLE "PageViewEvent" (
    "id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "discordUserId" TEXT,
    "referrer" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageViewEvent_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PageViewEvent"
ADD CONSTRAINT "PageViewEvent_discordUserId_fkey"
FOREIGN KEY ("discordUserId") REFERENCES "Member"("discordUserId")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "PageViewEvent_createdAt_idx" ON "PageViewEvent"("createdAt");
CREATE INDEX "PageViewEvent_path_createdAt_idx" ON "PageViewEvent"("path", "createdAt");
CREATE INDEX "PageViewEvent_visitorId_createdAt_idx" ON "PageViewEvent"("visitorId", "createdAt");
CREATE INDEX "PageViewEvent_discordUserId_createdAt_idx" ON "PageViewEvent"("discordUserId", "createdAt");
