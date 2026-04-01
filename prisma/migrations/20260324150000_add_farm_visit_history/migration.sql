CREATE TABLE "FarmVisit" (
    "id" TEXT NOT NULL,
    "viewerDiscordId" TEXT NOT NULL,
    "targetDiscordId" TEXT NOT NULL,
    "visitCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVisitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FarmVisit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FarmVisit_viewerDiscordId_targetDiscordId_key" ON "FarmVisit"("viewerDiscordId", "targetDiscordId");
CREATE INDEX "FarmVisit_viewerDiscordId_lastVisitedAt_idx" ON "FarmVisit"("viewerDiscordId", "lastVisitedAt");
CREATE INDEX "FarmVisit_viewerDiscordId_visitCount_idx" ON "FarmVisit"("viewerDiscordId", "visitCount");
